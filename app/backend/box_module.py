"""The Box module of step 2 (plan ``plans/two-step-solution.md``, stage 4).

The downstream detector is drawn by hand as **one upright rectangle per picture**. The Box makes that rectangle for every
picture from the detector boxes of step 1, which it names in its settings (a list in the right pane, not lines: the
detectors live in the other step):

* **two boxes** (``mode`` "two"): the left hole sets the left edge, the right hole the right edge, and up and down are
  measured from both holes. The part's own direction ``u`` runs from the left hole to the right hole, so the rectangle
  turns with the part;
* **one box** (``mode`` "one"): the one box sets all four edges, in its own direction (its angle).

Each side is the box's **edge** (the margin is the background you see beyond the box) or its **centre** (``measure_from``).
The turned rectangle is squared off into the smallest upright one, as drawn by hand. The result is stored like a detector's:
one target ``box`` per picture hash, ``angle`` 0, so a Classifier anchored to the Box, the Dedup view and the cut-outs read it
unchanged (``flow.load_stored`` brings the results up to date when they are read).

Angles are degrees, positive counter-clockwise on screen (the convention of the stored detector boxes); the picture's y axis
points down. The part's x axis ``u`` is ``(cos a, -sin a)`` and its y axis ``v`` ("down" in the part) is ``(sin a, cos a)``.
"""
from __future__ import annotations

import hashlib
import json
import math

import db
import flow
import labels

TARGET = "box"  # the one target a Box gives
MODES = ("one", "two")
MEASURE = ("edge", "centre")
SIDES = ("left", "right", "up", "down")
MAX_MARGIN = 100000.0
ALGORITHM = 1  # bump when the geometry changes, so stored rectangles are made again
_KEPT: dict[tuple[str, str], tuple[int, dict]] = {}  # (camera, box) -> (db.write_epoch(), results): worked out again only after a write


def default_config() -> dict:
    return {"mode": "two", "holes": [], "measure_from": "edge", "margins": {side: 0.0 for side in SIDES}}


def needed(node: dict) -> int:
    """How many detector boxes the mode needs."""
    return 1 if node.get("mode") == "one" else 2


def holes_of(node: dict) -> list[dict]:
    """The chosen detector boxes the mode uses (``[{"detector", "target"}]``); fewer while the choice is not complete."""
    holes = [h for h in node.get("holes") or [] if isinstance(h, dict) and h.get("detector") and h.get("target")]
    return holes[: needed(node)]


def margins_of(node: dict) -> dict[str, float]:
    stored = node.get("margins") or {}
    return {side: float(stored.get(side, 0.0)) for side in SIDES}


# --- settings -------------------------------------------------------------------------
def candidates(camera: str, graph: dict) -> list[dict]:
    """The detector boxes of step 1 a Box can use: every target (slot) with examples of every step-1 detector."""
    import chain  # noqa: PLC0415  (it imports flow)

    stored = chain.load_layout(camera)["nodes"]
    out = []
    for node_id, node in sorted(graph["nodes"].items()):
        if node.get("kind") != "detector" or flow.step_of(node) != 1:
            continue
        name = (stored.get(node_id) or {}).get("label") or f"Detector {node_id.split(':')[1]}"
        for slot in flow.all_slots(node, with_examples=True):
            out.append({"detector": node_id, "target": slot, "detector_label": name, "label": f"{name} · {slot}"})
    return out


def apply_settings(camera: str, graph: dict, node: dict, raw: dict) -> None:
    """Change a Box's settings from a request (``mode``, ``holes``, ``measure_from``, ``margins``); raises ``FlowError``."""
    if "mode" in raw:
        if raw["mode"] not in MODES:
            raise flow.FlowError("A Box works with one detector box or with two.")
        node["mode"] = raw["mode"]
    if "holes" in raw:
        holes = raw["holes"]
        if not isinstance(holes, list) or len(holes) > 2:
            raise flow.FlowError("Choose at most two detector boxes.")
        allowed = {(c["detector"], c["target"]) for c in candidates(camera, graph)}
        clean = []
        for h in holes:
            if not isinstance(h, dict) or (h.get("detector"), h.get("target")) not in allowed:
                raise flow.FlowError("That is not a detector box of step 1.")
            clean.append({"detector": h["detector"], "target": h["target"]})
        if len({(h["detector"], h["target"]) for h in clean}) != len(clean):
            raise flow.FlowError("Choose two different detector boxes.")
        node["holes"] = clean
    if "measure_from" in raw:
        if raw["measure_from"] not in MEASURE:
            raise flow.FlowError("Measure from the box edge or from its centre.")
        node["measure_from"] = raw["measure_from"]
    if "margins" in raw:
        given = raw["margins"]
        if not isinstance(given, dict) or any(k not in SIDES for k in given):
            raise flow.FlowError("The margins are left, right, up and down.")
        merged = margins_of(node)
        for side, value in given.items():
            number = flow._finite(value, f"The {side} margin")
            if abs(number) > MAX_MARGIN:
                raise flow.FlowError(f"The {side} margin is too large.")
            merged[side] = number
        node["margins"] = merged


# --- geometry -------------------------------------------------------------------------
def _axes(angle: float) -> tuple[tuple[float, float], tuple[float, float]]:
    """The part's x axis ``u`` and y axis ``v`` in picture coordinates for an angle (degrees, counter-clockwise on screen)."""
    t = math.radians(angle)
    return (math.cos(t), -math.sin(t)), (math.sin(t), math.cos(t))


def _dot(a: tuple[float, float], b: tuple[float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _reach(box: dict, axis: tuple[float, float], measure: str) -> float:
    """How far a box reaches from its centre along ``axis``: half its extent there (``edge``) or nothing (``centre``)."""
    if measure == "centre":
        return 0.0
    bu, bv = _axes(float(box.get("angle", 0.0)))
    return abs(_dot(axis, bu)) * float(box["w"]) / 2 + abs(_dot(axis, bv)) * float(box["h"]) / 2


def rectangle(boxes: list[dict], mode: str, measure: str, margins: dict[str, float]) -> dict | None:
    """The rectangle of one picture from the detector boxes on the whole picture (one or two, left hole first): the part's
    direction ``angle``, its four ``corners`` (turned with the part) and the upright box round them (``x, y, w, h``).
    ``None`` when the margins leave no rectangle."""
    if mode == "two":
        left, right = boxes
        dx, dy = right["x"] - left["x"], right["y"] - left["y"]
        angle = math.degrees(math.atan2(-dy, dx)) if math.hypot(dx, dy) > 1e-6 else float(left.get("angle", 0.0))
    else:
        left = right = boxes[0]
        angle = float(left.get("angle", 0.0))
    u, v = _axes(angle)
    lo_u = _dot((left["x"], left["y"]), u) - _reach(left, u, measure) - margins["left"]
    hi_u = _dot((right["x"], right["y"]), u) + _reach(right, u, measure) + margins["right"]
    lo_v = min(_dot((b["x"], b["y"]), v) - _reach(b, v, measure) for b in boxes) - margins["up"]
    hi_v = max(_dot((b["x"], b["y"]), v) + _reach(b, v, measure) for b in boxes) + margins["down"]
    if hi_u - lo_u < 1.0 or hi_v - lo_v < 1.0:
        return None
    corners = [(s * u[0] + t * v[0], s * u[1] + t * v[1]) for s, t in ((lo_u, lo_v), (hi_u, lo_v), (hi_u, hi_v), (lo_u, hi_v))]
    xs, ys = [c[0] for c in corners], [c[1] for c in corners]
    return {
        "angle": round(angle, 3),
        "corners": [[round(x, 2), round(y, 2)] for x, y in corners],
        "x": round((min(xs) + max(xs)) / 2, 2), "y": round((min(ys) + max(ys)) / 2, 2),
        "w": round(max(xs) - min(xs), 2), "h": round(max(ys) - min(ys), 2),
    }


def _refs(node: dict) -> dict[str, tuple[str, str]]:
    return {str(i): (h["detector"], h["target"]) for i, h in enumerate(holes_of(node))}


def rectangles(camera: str, graph: dict, node_id: str, only: str | None = None) -> dict[str, dict]:
    """The rectangle of every live picture (by frame name) where all the chosen detector boxes were found."""
    node = graph["nodes"][node_id]
    refs = _refs(node)
    if len(refs) < needed(node):
        return {}
    found = flow.whole_picture_boxes(camera, graph, refs, only)
    out = {}
    for frame, boxes in found.items():
        if len(boxes) < len(refs):
            continue
        rect = rectangle([boxes[k] for k in refs], node.get("mode", "two"), node.get("measure_from", "edge"), margins_of(node))
        if rect:
            out[frame] = rect
    return out


# --- stored results (read like a detector's) ----------------------------------------------
def signature(graph: dict, node_id: str) -> str:
    """Changes when the rectangles would: the settings and the signatures of the detectors the chosen boxes come from."""
    node = graph["nodes"][node_id]
    holes = holes_of(node)
    material = {
        "algo": ALGORITHM, "mode": node.get("mode", "two"), "measure": node.get("measure_from", "edge"), "margins": margins_of(node),
        "holes": [[h["detector"], h["target"], flow.signature(graph, h["detector"]) if h["detector"] in graph["nodes"] else "gone"] for h in holes],
    }
    return hashlib.sha1(json.dumps(material, sort_keys=True).encode()).hexdigest()[:16]


def _results_hash(camera: str, detector: str) -> str:
    """Changes whenever the detector's stored results do: a new run with the same settings, a box moved by hand, a new picture."""
    return hashlib.sha1((db.get_setting(camera, flow._results_key(detector)) or "").encode()).hexdigest()[:12]


def ensure(camera: str, node_id: str) -> dict:
    """The Box's stored results (``{"sig", "frames"}``), made again first when its settings or the detector runs it reads
    changed. Cheap while nothing was written (the answer is kept until the next write)."""
    epoch = db.write_epoch()
    kept = _KEPT.get((camera, node_id))
    if kept and kept[0] == epoch:
        return {"sig": kept[1]["sig"], "frames": dict(kept[1]["frames"])}
    graph = flow.load_graph(camera)
    node = graph["nodes"].get(node_id)
    if node is None:
        return {"sig": None, "frames": {}}
    runs = [_results_hash(camera, h["detector"]) for h in holes_of(node) if h["detector"] in graph["nodes"]]  # the detector results it reads (a run, or a box moved by hand)
    sig = hashlib.sha1(json.dumps([signature(graph, node_id), runs], sort_keys=True).encode()).hexdigest()[:16]
    stored = flow._load_raw(camera, node_id)
    if stored["sig"] != sig:
        hmap = labels.hash_map(camera)
        frames = {}
        for frame, rect in rectangles(camera, graph, node_id).items():
            key = hmap.get(frame)
            if key:
                frames[key] = {TARGET: {"x": rect["x"], "y": rect["y"], "w": rect["w"], "h": rect["h"], "angle": 0.0, "score": 1.0, "source": "box"}}
        flow._store(camera, node_id, sig, frames)
        stored = {"sig": sig, "frames": frames}
    _KEPT[(camera, node_id)] = (db.write_epoch() if db.write_epoch() == epoch else -1, stored)  # a write during the work: do not keep it
    return {"sig": stored["sig"], "frames": dict(stored["frames"])}


def frames(camera: str, node_id: str) -> list[str]:
    """The live pictures (by frame name) that have a rectangle: what a Classifier anchored to the Box can work on."""
    made = ensure(camera, node_id)["frames"]
    hmap = labels.hash_map(camera)
    return [f for f in flow._live_frames(camera) if hmap.get(f) in made]


# --- what the Box page and the canvas show -----------------------------------------------
def summary(camera: str, graph: dict, node_id: str) -> dict:
    """The light summary of the Chain box: its mode, the boxes chosen, and how many pictures have a rectangle."""
    node = graph["nodes"][node_id]
    holes = holes_of(node)
    labels_of = {(c["detector"], c["target"]): c["label"] for c in candidates(camera, graph)}
    ready = len(holes) == needed(node) and all((h["detector"], h["target"]) in labels_of for h in holes)
    return {
        "box_mode": node.get("mode", "two"), "measure_from": node.get("measure_from", "edge"), "margins": margins_of(node),
        "holes": [labels_of.get((h["detector"], h["target"]), f"{h['detector']} · {h['target']} (gone)") for h in holes],
        "ready": ready, "found": len(ensure(camera, node_id)["frames"]) if ready else 0, "total": len(flow._live_frames(camera)),
        "targets": [TARGET],
    }


def detail(camera: str, graph: dict, node_id: str) -> dict:
    """What the Box page needs: the settings, the detector boxes to choose from, which pictures have a rectangle, and
    which detectors have not been run since they changed (their boxes are the old ones)."""
    node = graph["nodes"][node_id]
    have = sorted(frames(camera, node_id))
    return {
        "mode": node.get("mode", "two"), "measure_from": node.get("measure_from", "edge"), "margins": margins_of(node), "holes": holes_of(node),
        "needed": needed(node), "candidates": candidates(camera, graph), "frames": have, "total": len(flow._live_frames(camera)),
        "stale": sorted({h["detector"] for h in holes_of(node) if h["detector"] in graph["nodes"] and flow.status(camera, h["detector"], graph) != "fresh"}),
    }


def frame_geometry(camera: str, graph: dict, node_id: str, frame: str) -> dict:
    """One picture for the Box page: its size, the chosen boxes on it, the turned rectangle and the upright one. ``missing``
    names the chosen boxes the detectors did not find here."""
    node = graph["nodes"][node_id]
    refs = _refs(node)
    key = db.frame_hash_for(camera, frame)
    size = flow._frame_sizes(camera).get(key) if key else None
    found = flow.whole_picture_boxes(camera, graph, refs, frame).get(frame, {}) if len(refs) == needed(node) else {}
    rect = rectangle([found[k] for k in refs], node.get("mode", "two"), node.get("measure_from", "edge"), margins_of(node)) if refs and len(found) == len(refs) else None
    return {
        "frame": frame, "size": {"w": size[0], "h": size[1]} if size else None,
        "holes": [{**found[k], "detector": refs[k][0], "target": refs[k][1]} for k in refs if k in found],
        "missing": [refs[k][1] for k in refs if k not in found],
        "rect": rect,
        "upright": {k: rect[k] for k in ("x", "y", "w", "h")} if rect else None,
    }
