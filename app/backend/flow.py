"""Measurement flow on the chain: detector boxes -> Calculate -> Tolerance -> a feature's Classify box.

This is the human-like analysis of a picture: find named targets (for example the left and right hole of a
component), compute a number from them (the angle from A to B), and compare it with nominal +- tolerance. The
result is an *opinion* (value, pass / fail / undetermined), shown next to the human's label in Classify. It never
labels a picture and is never blended with the classical or ResNet scores.

Storage needs no schema change; everything is per-camera settings:

  * ``flow.graph``         boxes (``det:N``, ``calc:N``, ``tol:N``) with their settings, and the arrows between
                           the boxes (``ingest -> det``, ``det -> det``, ``det -> calc``, ``calc -> tol``,
                           ``tol -> classify:<feature>``);
  * ``flow.det.<id>``      the boxes a detector found, by frame hash, with the signature of the settings that made them.

Calculate and Tolerance are pure functions of the stored boxes, so changing an operation, the nominal or the
tolerance never needs a new detection run.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math

import cv2
import numpy as np

import datamodel
import db
import labels
import rotsearch

GRAPH_KEY = "flow.graph"
RESULTS_PREFIX = "flow.det."
INGEST_ID = "ingest"
KINDS = ("detector", "calc", "tolerance")
PREFIX = {"detector": "det", "calc": "calc", "tolerance": "tol"}
KIND_OF = {v: k for k, v in PREFIX.items()}
ALGORITHM = 1  # bump when detection changes, so stored boxes are recomputed
OPERATIONS = {
    "angle": "Angle A to B",
    "distance": "Distance A to B",
    "dx": "dx (B minus A, to the right)",
    "dy": "dy (B minus A, downwards)",
}
MAX_TARGETS = 8
MAX_EXAMPLES = 6
MAX_EXAMPLE_SIDE = 400
NAME_MAX = 40
HISTOGRAM_BINS = 36
DEFAULT_PAD = 0.3


class FlowError(ValueError):
    """The request does not fit the flow."""


# --- ids and graph ------------------------------------------------------------
def kind_of(node_id: str) -> str | None:
    if node_id == INGEST_ID:
        return "ingest"
    if node_id.startswith("classify:"):
        return "classify"
    return KIND_OF.get(node_id.split(":", 1)[0])


def is_flow_id(node_id: str) -> bool:
    return kind_of(node_id) in KINDS


def load_graph(camera: str) -> dict:
    raw = db.get_setting(camera, GRAPH_KEY)
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                return {"nodes": dict(data.get("nodes") or {}), "edges": list(data.get("edges") or [])}
        except (ValueError, TypeError):
            pass
    return {"nodes": {}, "edges": []}


def save_graph(camera: str, graph: dict) -> None:
    db.set_setting(camera, GRAPH_KEY, json.dumps(graph, sort_keys=True))


def _default_config(kind: str) -> dict:
    if kind == "detector":
        return {"targets": [], "angle_range": None, "rotate": True, "pad": DEFAULT_PAD}
    if kind == "calc":
        return {"op": "angle", "a": None, "b": None, "clockwise": False}
    return {"nominal": None, "tolerance": 3.0}


def create_node(camera: str, kind: str) -> str:
    if kind not in KINDS:
        raise FlowError(f"Unknown box kind: {kind}")
    graph = load_graph(camera)
    n = 1
    while f"{PREFIX[kind]}:{n}" in graph["nodes"]:
        n += 1
    node_id = f"{PREFIX[kind]}:{n}"
    graph["nodes"][node_id] = {"kind": kind, **_default_config(kind)}
    if kind == "detector":
        graph["edges"].append({"source": INGEST_ID, "target": node_id})
    save_graph(camera, graph)
    return node_id


def _node(graph: dict, node_id: str) -> dict:
    node = graph["nodes"].get(node_id)
    if node is None:
        raise FlowError(f"Unknown box: {node_id}")
    return node


def parent_of(graph: dict, node_id: str) -> str | None:
    for e in graph["edges"]:
        if e["target"] == node_id and kind_of(e["source"]) in ("ingest", "detector", "calc"):
            return e["source"]
    return None


def children_of(graph: dict, node_id: str) -> list[str]:
    return [e["target"] for e in graph["edges"] if e["source"] == node_id]


def edge_allowed(graph: dict, source: str, target: str) -> str | None:
    """None when the arrow fits, else the reason it does not."""
    ks, kt = kind_of(source), kind_of(target)
    if source == target:
        return "A box cannot feed itself."
    if (ks, kt) not in {("ingest", "detector"), ("detector", "detector"), ("detector", "calc"), ("calc", "tolerance"), ("tolerance", "classify")}:
        names = {"ingest": "Ingest", "detector": "a detector", "calc": "Calculate", "tolerance": "Tolerance", "classify": "a Classify box"}
        return f"{names.get(ks, ks)} cannot feed {names.get(kt, kt)}."
    if is_flow_id(source) and source not in graph["nodes"]:
        return f"Unknown box: {source}"
    if is_flow_id(target) and target not in graph["nodes"]:
        return f"Unknown box: {target}"
    if ks == "detector" and kt == "detector":
        ancestor = source
        while ancestor and ancestor != INGEST_ID:
            if ancestor == target:
                return "That would make a loop."
            ancestor = parent_of(graph, ancestor)
    return None


def connect(camera: str, source: str, target: str) -> None:
    graph = load_graph(camera)
    reason = edge_allowed(graph, source, target)
    if reason:
        raise FlowError(reason)
    if kind_of(target) == "tolerance" or kind_of(target) in ("detector", "calc"):
        # One input per box: a new arrow replaces the old one.
        graph["edges"] = [e for e in graph["edges"] if e["target"] != target]
    elif kind_of(target) == "classify":
        graph["edges"] = [e for e in graph["edges"] if not (e["source"] == source and e["target"] == target)]
    graph["edges"].append({"source": source, "target": target})
    save_graph(camera, graph)


def disconnect(camera: str, source: str, target: str) -> None:
    graph = load_graph(camera)
    kept = [e for e in graph["edges"] if not (e["source"] == source and e["target"] == target)]
    if len(kept) == len(graph["edges"]):
        raise FlowError("There is no such arrow.")
    graph["edges"] = kept
    if kind_of(target) == "detector" and parent_of(graph, target) is None:
        graph["edges"].append({"source": INGEST_ID, "target": target})  # a detector always reads something
    save_graph(camera, graph)


def delete_preview(camera: str, node_id: str) -> dict:
    graph = load_graph(camera)
    _node(graph, node_id)
    stored = load_stored(camera, node_id)
    return {
        "node": node_id,
        "kind": kind_of(node_id),
        "detections": len(stored["frames"]),
        "arrows": sum(1 for e in graph["edges"] if node_id in (e["source"], e["target"])),
    }


def delete_node(camera: str, node_id: str) -> None:
    graph = load_graph(camera)
    _node(graph, node_id)
    del graph["nodes"][node_id]
    orphans = [e["target"] for e in graph["edges"] if e["source"] == node_id and kind_of(e["target"]) == "detector"]
    graph["edges"] = [e for e in graph["edges"] if node_id not in (e["source"], e["target"])]
    for orphan in orphans:
        if orphan in graph["nodes"] and parent_of(graph, orphan) is None:
            graph["edges"].append({"source": INGEST_ID, "target": orphan})
    save_graph(camera, graph)
    _drop_results(camera, node_id)


def drop_classify_edges(camera: str, feature: str) -> None:
    """A Classify box went with its ROI: forget the arrows into it."""
    graph = load_graph(camera)
    target = f"classify:{feature}"
    kept = [e for e in graph["edges"] if e["target"] != target]
    if len(kept) != len(graph["edges"]):
        graph["edges"] = kept
        save_graph(camera, graph)


# --- settings of a box ----------------------------------------------------------
def _name(value: object, what: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise FlowError(f"{what} needs a name.")
    if len(text) > NAME_MAX:
        raise FlowError(f"{what} can have at most {NAME_MAX} characters.")
    return text


def _finite(value: object, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise FlowError(f"{what} must be a number.")
    return float(value)


def update_node(camera: str, node_id: str, raw: dict) -> dict:
    """Change the settings of a box. Targets and examples of a detector have their own calls."""
    graph = load_graph(camera)
    node = _node(graph, node_id)
    kind = node["kind"]
    if kind == "detector":
        if "rotate" in raw:
            node["rotate"] = bool(raw["rotate"])
        if "pad" in raw:
            pad = _finite(raw["pad"], "Padding")
            if not 0.0 <= pad <= 2.0:
                raise FlowError("Padding must be between 0 and 2.")
            node["pad"] = pad
        if "angle_range" in raw:
            rng = raw["angle_range"]
            if rng is None:
                node["angle_range"] = None
            else:
                if not isinstance(rng, (list, tuple)) or len(rng) != 2:
                    raise FlowError("The angle range is a low and a high angle.")
                lo, hi = _finite(rng[0], "Angle"), _finite(rng[1], "Angle")
                if hi < lo or hi - lo > 360:
                    raise FlowError("The angle range must go up and cover at most 360 degrees.")
                node["angle_range"] = [lo, hi]
    elif kind == "calc":
        if "op" in raw:
            if raw["op"] not in OPERATIONS:
                raise FlowError(f"Unknown operation: {raw['op']}")
            node["op"] = raw["op"]
        for key in ("a", "b"):
            if key in raw:
                node[key] = None if raw[key] in (None, "") else str(raw[key])
        if "clockwise" in raw:
            node["clockwise"] = bool(raw["clockwise"])
    else:
        if "nominal" in raw:
            node["nominal"] = None if raw["nominal"] is None else _finite(raw["nominal"], "Nominal")
        if "tolerance" in raw:
            tolerance = _finite(raw["tolerance"], "Tolerance")
            if tolerance <= 0:
                raise FlowError("The tolerance must be greater than zero.")
            node["tolerance"] = tolerance
    save_graph(camera, graph)
    return node


def add_target(camera: str, node_id: str, name: str) -> None:
    graph = load_graph(camera)
    node = _node(graph, node_id)
    if node["kind"] != "detector":
        raise FlowError("Only a detector has targets.")
    name = _name(name, "A target")
    if any(t["name"] == name for t in node["targets"]):
        raise FlowError(f"There is already a target named {name}.")
    if len(node["targets"]) >= MAX_TARGETS:
        raise FlowError(f"A detector can have at most {MAX_TARGETS} targets.")
    node["targets"].append({"name": name, "examples": []})
    save_graph(camera, graph)


def remove_target(camera: str, node_id: str, name: str) -> None:
    graph = load_graph(camera)
    node = _node(graph, node_id)
    node["targets"] = [t for t in node.get("targets", []) if t["name"] != name]
    save_graph(camera, graph)


def _read(camera: str, frame: str) -> np.ndarray:
    import curation  # noqa: PLC0415

    if frame != frame.split("/")[-1] or not (datamodel.unsorted_dir(camera) / frame).is_file():
        raise FlowError(f"Unknown frame: {frame}")
    return curation.load_image(datamodel.unsorted_dir(camera) / frame)


def _cut(camera: str, frame: str, box: list[float]) -> tuple[list[int], str]:
    """The example crop of ``box`` (pixels ``[x, y, w, h]``) on ``frame``: the clipped box and the crop as base64 PNG."""
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise FlowError("The example box is x, y, width, height.")
    image = _read(camera, frame)
    x, y, w, h = (int(round(_finite(v, "Box"))) for v in box)
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(image.shape[1], x + w), min(image.shape[0], y + h)
    if x1 - x0 < 5 or y1 - y0 < 5:
        raise FlowError("The example is too small; draw a larger box.")
    if max(x1 - x0, y1 - y0) > MAX_EXAMPLE_SIDE:
        raise FlowError(f"The example can be at most {MAX_EXAMPLE_SIDE} pixels on a side.")
    crop = image[y0:y1, x0:x1]
    if float(np.std(crop)) < rotsearch.MIN_TEXTURE:
        raise FlowError("The example is flat; there is nothing to recognise in it.")
    ok, buf = cv2.imencode(".png", crop)
    if not ok:
        raise FlowError("Cannot store the example.")
    return [x0, y0, x1 - x0, y1 - y0], base64.b64encode(buf.tobytes()).decode()


def add_example(camera: str, node_id: str, target: str, frame: str, box: list[float]) -> dict:
    """Cut an example crop (pixels ``[x, y, w, h]`` of the frame) and keep it with the target."""
    graph = load_graph(camera)
    node = _node(graph, node_id)
    if node["kind"] != "detector":
        raise FlowError("Only a detector has examples.")
    entry = next((t for t in node["targets"] if t["name"] == target), None)
    if entry is None:
        raise FlowError(f"Unknown target: {target}")
    if len(entry["examples"]) >= MAX_EXAMPLES:
        raise FlowError(f"A target can have at most {MAX_EXAMPLES} examples.")
    clipped, png = _cut(camera, frame, box)
    entry["examples"].append({"frame": frame, "box": clipped, "png": png})
    save_graph(camera, graph)
    return entry["examples"][-1]


def update_example(camera: str, node_id: str, target: str, index: int, box: list[float]) -> dict:
    """Move or resize an example rectangle on its own picture; the crop is cut again (the detector then needs a new run)."""
    graph = load_graph(camera)
    node = _node(graph, node_id)
    entry = next((t for t in node.get("targets", []) if t["name"] == target), None)
    if entry is None or not 0 <= index < len(entry["examples"]):
        raise FlowError("There is no such example.")
    example = entry["examples"][index]
    example["box"], example["png"] = _cut(camera, example["frame"], box)
    save_graph(camera, graph)
    return example


def remove_example(camera: str, node_id: str, target: str, index: int) -> None:
    graph = load_graph(camera)
    node = _node(graph, node_id)
    entry = next((t for t in node.get("targets", []) if t["name"] == target), None)
    if entry is None or not 0 <= index < len(entry["examples"]):
        raise FlowError("There is no such example.")
    del entry["examples"][index]
    save_graph(camera, graph)


def _example_image(example: dict) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(base64.b64decode(example["png"]), np.uint8), cv2.IMREAD_UNCHANGED)


# --- detection -------------------------------------------------------------------
def signature(graph: dict, node_id: str) -> str:
    """Changes when what a detector would find changes: its targets, examples, search settings and its input."""
    node = graph["nodes"][node_id]
    parent = parent_of(graph, node_id)
    material = {
        "algo": ALGORITHM,
        "targets": [(t["name"], [e["png"] for e in t["examples"]]) for t in node["targets"]],
        "rotate": node["rotate"],
        "range": node["angle_range"],
        "pad": node["pad"],
        "parent": signature(graph, parent) if parent and parent != INGEST_ID else None,
    }
    return hashlib.sha1(json.dumps(material, sort_keys=True).encode()).hexdigest()[:16]


def _results_key(node_id: str) -> str:
    return RESULTS_PREFIX + node_id


def load_stored(camera: str, node_id: str) -> dict:
    raw = db.get_setting(camera, _results_key(node_id))
    if raw:
        try:
            data = json.loads(raw)
            return {"sig": data.get("sig"), "frames": dict(data.get("frames") or {})}
        except (ValueError, TypeError):
            pass
    return {"sig": None, "frames": {}}


def _store(camera: str, node_id: str, sig: str | None, frames: dict) -> None:
    db.set_setting(camera, _results_key(node_id), json.dumps({"sig": sig, "frames": frames}))


def _drop_results(camera: str, node_id: str) -> None:
    con = db.connect()
    try:
        con.execute("DELETE FROM settings WHERE camera=? AND key=?", (camera, _results_key(node_id)))
        con.commit()
    finally:
        con.close()


def status(camera: str, node_id: str, graph: dict | None = None) -> str:
    """``none`` (never run), ``fresh`` or ``stale`` (settings or input changed since the run)."""
    graph = graph or load_graph(camera)
    stored = load_stored(camera, node_id)
    if stored["sig"] is None:
        return "none"
    return "fresh" if stored["sig"] == signature(graph, node_id) else "stale"


def _live_frames(camera: str) -> list[str]:
    deleted = db.deleted_frames_of(camera)
    return [p.name for p in datamodel.list_unsorted(camera) if p.name not in deleted]


def _match_entry(match: rotsearch.Match, source: str = "auto") -> dict:
    return {
        "x": round(float(match.x), 2),
        "y": round(float(match.y), 2),
        "angle": round(float(match.angle), 2),
        "score": round(float(match.score), 3),
        "w": int(match.w),
        "h": int(match.h),
        "source": source,
    }


def _as_match(entry: dict) -> rotsearch.Match:
    return rotsearch.Match(entry["x"], entry["y"], entry["angle"], entry.get("score", 1.0), entry["w"], entry["h"])


def detector_order(graph: dict) -> list[str]:
    """Detectors, inputs before the detectors that read them."""
    order: list[str] = []

    def visit(node_id: str) -> None:
        if node_id in order:
            return
        parent = parent_of(graph, node_id)
        if parent and parent in graph["nodes"]:
            visit(parent)
        order.append(node_id)

    for node_id, node in sorted(graph["nodes"].items()):
        if node["kind"] == "detector":
            visit(node_id)
    return order


def run_detector(camera: str, node_id: str, report=None, frames: list[str] | None = None) -> dict:
    """Search every live frame with this detector (its input detector must have been run). Boxes a human moved
    keep their place. Returns the counts."""
    graph = load_graph(camera)
    node = _node(graph, node_id)
    if node["kind"] != "detector":
        raise FlowError("Only a detector can be run.")
    usable = [t for t in node["targets"] if t["examples"]]
    if not usable:
        raise FlowError("Draw an example for at least one target first.")
    parent = parent_of(graph, node_id)
    parent_frames: dict = {}
    if parent and parent != INGEST_ID:
        if status(camera, parent, graph) != "fresh":
            raise FlowError("Run the detector before this one first; its boxes are the search areas here.")
        parent_frames = load_stored(camera, parent)["frames"]
    examples = {t["name"]: [_example_image(e) for e in t["examples"]] for t in usable}
    angle_range = tuple(node["angle_range"]) if node["angle_range"] else None
    if not node["rotate"]:
        angle_range = (0.0, 0.0)
    previous = load_stored(camera, node_id)["frames"]
    hmap = labels.hash_map(camera)
    names = frames if frames is not None else _live_frames(camera)
    out: dict[str, dict] = {}
    import curation  # noqa: PLC0415

    for i, frame in enumerate(names, 1):
        key = hmap.get(frame)
        if key:
            old = previous.get(key, {})
            found: dict[str, dict] = {n: e for n, e in old.items() if e.get("source") == "human"}
            try:
                picture = curation.load_image(datamodel.unsorted_dir(camera) / frame)
            except Exception:  # noqa: BLE001 - an unreadable frame has no boxes
                picture = None
            if picture is not None:
                for name, imgs in examples.items():
                    if name in found:
                        continue
                    region = None
                    if parent and parent != INGEST_ID:
                        inside = parent_frames.get(key, {}).get(name)
                        if inside is None:
                            continue
                        region = _as_match(inside).region(picture.shape, node["pad"])
                    match = rotsearch.find_targets(picture, {name: imgs}, angle_range=angle_range, region=region)[name]
                    if match is not None:
                        found[name] = _match_entry(match)
            out[key] = found
        if report:
            report({"phase": "detecting", "node": node_id, "done": i, "total": len(names)})
    _store(camera, node_id, signature(graph, node_id), out)
    return summarize_detector(camera, node_id)


def run_all(camera: str, report=None) -> dict:
    graph = load_graph(camera)
    done = {}
    for node_id in detector_order(graph):
        if any(t["examples"] for t in graph["nodes"][node_id]["targets"]):
            done[node_id] = run_detector(camera, node_id, report)
    return done


def set_box(camera: str, node_id: str, frame: str, target: str, x: float, y: float, angle: float | None = None) -> dict:
    """A human places (or moves) one box. It is kept when the detector runs again."""
    graph = load_graph(camera)
    node = _node(graph, node_id)
    entry = next((t for t in node.get("targets", []) if t["name"] == target), None)
    if entry is None or not entry["examples"]:
        raise FlowError(f"Unknown target: {target}")
    key = labels.hash_map(camera).get(frame)
    if not key:
        raise FlowError(f"Unknown frame: {frame}")
    stored = load_stored(camera, node_id)
    boxes = stored["frames"].setdefault(key, {})
    old = boxes.get(target)
    example = entry["examples"][0]
    boxes[target] = {
        "x": round(_finite(x, "x"), 2),
        "y": round(_finite(y, "y"), 2),
        "angle": round(_finite(angle, "angle"), 2) if angle is not None else (old or {}).get("angle", 0.0),
        "score": 1.0,
        "w": (old or {}).get("w", example["box"][2]),
        "h": (old or {}).get("h", example["box"][3]),
        "source": "human",
    }
    _store(camera, node_id, stored["sig"] or signature(graph, node_id), stored["frames"])
    return boxes[target]


def summarize_detector(camera: str, node_id: str) -> dict:
    graph = load_graph(camera)
    node = _node(graph, node_id)
    stored = load_stored(camera, node_id)
    names = [t["name"] for t in node["targets"] if t["examples"]]
    per = {n: sum(1 for f in stored["frames"].values() if n in f) for n in names}
    complete = sum(1 for f in stored["frames"].values() if all(n in f for n in names)) if names else 0
    total = len(stored["frames"])
    return {"frames": total, "found": per, "complete": complete, "review": total - complete}


def frame_boxes(camera: str, node_id: str) -> dict[str, dict]:
    """Stored boxes by frame name (only live frames the stored run knows)."""
    stored = load_stored(camera, node_id)["frames"]
    hmap = labels.hash_map(camera)
    result: dict[str, dict] = {}
    for frame in _live_frames(camera):
        key = hmap.get(frame)
        if key in stored:
            result[frame] = stored[key]
    return result


def review_frames(camera: str, node_id: str) -> list[str]:
    """Frames where a target with examples has no box: the ones a human should look at."""
    graph = load_graph(camera)
    names = [t["name"] for t in _node(graph, node_id)["targets"] if t["examples"]]
    return [f for f, boxes in frame_boxes(camera, node_id).items() if any(n not in boxes for n in names)]


# --- calculate --------------------------------------------------------------------
def point_names(graph: dict, calc_id: str) -> list[str]:
    parent = parent_of(graph, calc_id)
    if not parent or parent not in graph["nodes"]:
        return []
    return [t["name"] for t in graph["nodes"][parent]["targets"] if t["examples"]]


def effective_points(graph: dict, calc_id: str) -> tuple[str | None, str | None]:
    """The two points a Calculate box uses: its choice, else the first two targets of its detector."""
    node = graph["nodes"][calc_id]
    names = point_names(graph, calc_id)
    a = node["a"] if node["a"] in names else (names[0] if names else None)
    b = node["b"] if node["b"] in names else next((n for n in names if n != a), None)
    return a, b


def compute(op: str, a: tuple[float, float], b: tuple[float, float], clockwise: bool = False) -> float:
    """The measure from point A to point B, picture coordinates (y points down).

    ``angle``: 0 deg points right; positive turns counter-clockwise on screen unless ``clockwise``; 0-360."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    if op == "dx":
        return dx
    if op == "dy":
        return dy
    if op == "distance":
        return math.hypot(dx, dy)
    if op == "angle":
        value = math.degrees(math.atan2(dy if clockwise else -dy, dx))
        return value % 360.0
    raise FlowError(f"Unknown operation: {op}")


def calc_values(camera: str, calc_id: str, graph: dict | None = None) -> dict[str, float | None]:
    """The measured number by frame hash (None when a point is missing)."""
    graph = graph or load_graph(camera)
    node = _node(graph, calc_id)
    parent = parent_of(graph, calc_id)
    a, b = effective_points(graph, calc_id)
    if not parent or a is None or b is None:
        return {}
    frames = load_stored(camera, parent)["frames"]
    values: dict[str, float | None] = {}
    for key, boxes in frames.items():
        if a in boxes and b in boxes:
            values[key] = compute(node["op"], (boxes[a]["x"], boxes[a]["y"]), (boxes[b]["x"], boxes[b]["y"]), node["clockwise"])
        else:
            values[key] = None
    return values


# --- tolerance --------------------------------------------------------------------
def deviation(value: float, nominal: float, wrap: bool) -> float:
    """Signed distance from nominal; an angle wraps around (359 and 1 degrees are 2 degrees apart)."""
    d = value - nominal
    if wrap:
        d = (d + 180.0) % 360.0 - 180.0
    return d


def tolerance_source(graph: dict, tol_id: str) -> str | None:
    parent = parent_of_any(graph, tol_id)
    return parent if parent and kind_of(parent) == "calc" else None


def parent_of_any(graph: dict, node_id: str) -> str | None:
    for e in graph["edges"]:
        if e["target"] == node_id:
            return e["source"]
    return None


def judge(value: float | None, node: dict, wrap: bool) -> str:
    if value is None or node["nominal"] is None:
        return "undetermined"
    return "pass" if abs(deviation(value, node["nominal"], wrap)) <= node["tolerance"] + 1e-9 else "fail"


def tolerance_state(camera: str, tol_id: str) -> dict:
    """Per-frame value and verdict of a Tolerance box, with counts and a histogram of the values."""
    graph = load_graph(camera)
    node = _node(graph, tol_id)
    calc_id = tolerance_source(graph, tol_id)
    empty = {"values": {}, "verdicts": {}, "counts": {"pass": 0, "fail": 0, "undetermined": 0}, "histogram": None, "wrap": False, "unit": ""}
    if not calc_id:
        return empty
    calc = graph["nodes"][calc_id]
    wrap = calc["op"] == "angle"
    by_key = calc_values(camera, calc_id, graph)
    hmap = labels.hash_map(camera)
    values: dict[str, float | None] = {}
    verdicts: dict[str, str] = {}
    for frame in _live_frames(camera):
        key = hmap.get(frame)
        if key not in by_key:
            continue
        values[frame] = by_key[key]
        verdicts[frame] = judge(by_key[key], node, wrap)
    counts = {"pass": 0, "fail": 0, "undetermined": 0}
    for v in verdicts.values():
        counts[v] += 1
    numbers = [v for v in values.values() if v is not None]
    histogram = None
    if numbers:
        lo, hi = (0.0, 360.0) if wrap else (min(numbers), max(numbers))
        if hi - lo < 1e-9:
            hi = lo + 1.0
        bins = [0] * HISTOGRAM_BINS
        for v in numbers:
            bins[min(HISTOGRAM_BINS - 1, int((v - lo) / (hi - lo) * HISTOGRAM_BINS))] += 1
        histogram = {"low": lo, "high": hi, "bins": bins}
    return {
        "values": values,
        "verdicts": verdicts,
        "counts": counts,
        "histogram": histogram,
        "wrap": wrap,
        "unit": "deg" if wrap else ("px" if calc["op"] != "angle" else ""),
    }


def feature_opinions(camera: str, feature: str) -> dict:
    """What the Tolerance boxes arrowed into this feature's Classify box say, by frame name."""
    graph = load_graph(camera)
    target = f"classify:{feature}"
    boxes = []
    for e in graph["edges"]:
        if e["target"] == target and kind_of(e["source"]) == "tolerance" and e["source"] in graph["nodes"]:
            state = tolerance_state(camera, e["source"])
            node = graph["nodes"][e["source"]]
            boxes.append({"box": e["source"], "nominal": node["nominal"], "tolerance": node["tolerance"], "unit": state["unit"], "values": state["values"], "verdicts": state["verdicts"], "counts": state["counts"]})
    return {"feature": feature, "boxes": boxes}


def freeze_record(camera: str, feature: str) -> list[dict]:
    """What a freeze records about these rules (settings and counts, never pictures)."""
    return [{"box": b["box"], "nominal": b["nominal"], "tolerance": b["tolerance"], "counts": b["counts"]} for b in feature_opinions(camera, feature)["boxes"]]


# --- the box as the UI shows it ------------------------------------------------------
def node_detail(camera: str, node_id: str, graph: dict | None = None) -> dict:
    graph = graph or load_graph(camera)
    node = _node(graph, node_id)
    kind = node["kind"]
    detail: dict = {"kind": kind}
    if kind == "detector":
        parent = parent_of(graph, node_id)
        detail.update({
            "input": parent,
            "targets": [
                {"name": t["name"], "examples": [{"frame": e["frame"], "box": e["box"], "png": "data:image/png;base64," + e["png"]} for e in t["examples"]]}
                for t in node["targets"]
            ],
            "rotate": node["rotate"],
            "angle_range": node["angle_range"],
            "pad": node["pad"],
            "status": status(camera, node_id, graph),
            "summary": summarize_detector(camera, node_id),
        })
    elif kind == "calc":
        names = point_names(graph, node_id)
        a, b = effective_points(graph, node_id)
        values = [v for v in calc_values(camera, node_id, graph).values() if v is not None]
        detail.update({
            "op": node["op"], "operations": OPERATIONS, "points": names, "a": a, "b": b, "clockwise": node["clockwise"],
            "measured": len(values),
        })
    else:
        calc_id = tolerance_source(graph, node_id)
        state = tolerance_state(camera, node_id)
        detail.update({
            "nominal": node["nominal"], "tolerance": node["tolerance"], "calc": calc_id,
            "wrap": state["wrap"], "unit": state["unit"], "counts": state["counts"], "histogram": state["histogram"],
            "features": [e["target"].split(":", 1)[1] for e in graph["edges"] if e["source"] == node_id],
        })
    return detail
