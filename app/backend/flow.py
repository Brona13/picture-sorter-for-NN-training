"""Measurement flow on the chain: detector boxes -> Calculate -> Evaluation -> a feature's Classify box.

This is the human-like analysis of a picture: find named targets (for example the left and right hole of a
component), compute a number from them (the angle from A to B), and compare it with nominal +- tolerance. The
result is an *opinion* (value, pass / fail / undetermined), shown next to the human's label in Classify. It never
labels a picture and is never blended with the classical or ResNet scores.

Storage needs no schema change; everything is per-camera settings:

  * ``flow.graph``         boxes (``det:N``, ``calc:N``, ``eval:N``) with their settings, and the arrows between
                           the boxes (``ingest -> det``, ``det -> det``, ``det -> calc``, ``calc -> eval``,
                           ``eval -> classify:<feature>``);
  * ``flow.det.<id>``      the boxes a detector found, by frame hash, with the signature of the settings that made them.

Calculate and Evaluation are pure functions of the stored boxes, so changing an operation, the nominal or the
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
import lines
import preprocess
import rotsearch

GRAPH_KEY = "flow.graph"
RESULTS_PREFIX = "flow.det."
INGEST_ID = "ingest"
KINDS = ("crop", "detector", "calc", "evaluation", "dedup")
PREFIX = {"crop": "crop", "detector": "det", "calc": "calc", "evaluation": "eval", "dedup": "dedup"}
KIND_OF = {v: k for k, v in PREFIX.items()}
PICTURE_KINDS = ("crop", "detector")  # boxes that read a picture (a box with no line reads the whole picture)
ALGORITHM = 1  # bump when detection changes, so stored boxes are recomputed
OPERATIONS = {
    "angle": "Angle A to B",
    "distance": "Distance A to B",
    "dx": "dx (B minus A, to the right)",
    "dy": "dy (B minus A, downwards)",
    "offset": "Offset of B from A (dx, dy; judged by a zone)",
}
ZONE_SHAPES = ("circle", "rect")
DEFAULT_ZONE = {"shape": "circle", "center": None, "radius": 10.0, "half": [10.0, 10.0]}
MAX_TARGETS = 8
MAX_STEPS = 16  # picture edits (crop / filter) one box holds
STEP_OPS = ("crop", "filter")
MAX_EXAMPLES = 6
MAX_EXAMPLE_SIDE = 400  # longest side (px) an example is matched at; a larger one is stored shrunk and the detector shrinks the picture the same way
MIN_MATCH_SIDE = 8  # after that shrinking, the shorter side of the smallest example of a detector must stay at least this many pixels
NAME_MAX = 40
HISTOGRAM_BINS = 36
DEFAULT_PAD = 0.3


class FlowError(ValueError):
    """The request does not fit the flow."""


# --- the picture a box works on -----------------------------------------------------
def clean_rect(raw: object) -> list[float] | None:
    """A crop rectangle ``[x, y, w, h]`` as fractions of the input picture, or ``None`` (no crop)."""
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        raise FlowError("The crop is x, y, width, height as fractions of the picture.")
    x, y, w, h = (round(_finite(v, "The crop"), 5) for v in raw)
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1 + 1e-6 or y + h > 1 + 1e-6:
        raise FlowError("The crop must lie inside the picture.")
    return [x, y, min(w, 1 - x), min(h, 1 - y)]


def _pixel_box(rect: list[float], width: int, height: int) -> tuple[int, int, int, int]:
    from roi import ROI  # noqa: PLC0415

    return ROI("crop", *rect).to_pixels(width, height)


PIXEL_CENTRE = 0.5  # a detector reports the index of the centre pixel; as a position on the picture it is half a pixel further


class NoCrop(FlowError):
    """A Crop that follows a detector has no rectangle on this picture (the detector found nothing, or the rectangle
    would leave the picture)."""


def is_follow(step: object) -> bool:
    """A step of ``input_rects`` is a rectangle ``[x, y, w, h]`` (fractions), a Crop that follows a detector target,
    ``{"follow": {detector, target, mode}, "size": [w, h], "offset": [dx, dy]}`` (pixels), or a filter, see :func:`is_filter`."""
    return isinstance(step, dict) and "follow" in step


def is_filter(step: object) -> bool:
    """A filter step: ``{"filter": {"name": ..., "params": {...}}}``. It changes the pixels, never the geometry."""
    return isinstance(step, dict) and "filter" in step


def has_follow(steps: list) -> bool:
    return any(is_follow(s) for s in steps)


class Finder:
    """The boxes detectors stored, loaded once, to resolve the Crop boxes that follow a detector on a picture."""

    def __init__(self, camera: str) -> None:
        self.camera = camera
        self._frames: dict[str, dict] = {}

    def box(self, detector: str, frame_hash: str, target: str) -> dict | None:
        if detector not in self._frames:
            self._frames[detector] = load_stored(self.camera, detector)["frames"]
        return self._frames[detector].get(frame_hash, {}).get(target)

    def for_frame(self, frame_hash: str | None):
        """A function from a following step to the box its detector stored on this picture (None when none)."""
        def found(step: dict) -> dict | None:
            if frame_hash is None:
                return None
            f = step["follow"]
            return self.box(f["detector"], frame_hash, f["target"])

        return found


def step_box(step, width: int, height: int, found=None) -> tuple[int, int, int, int]:
    """The pixel box ``(x0, y0, x1, y1)`` a step cuts out of a ``width`` x ``height`` picture. Raises :class:`NoCrop`
    for a following step without a box on this picture or with a rectangle that is not wholly inside it."""
    if is_filter(step):
        raise FlowError("A filter has no rectangle.")
    if not is_follow(step):
        return _pixel_box(step, width, height)
    entry = found(step) if found else None
    if entry is None:
        f = step["follow"]
        raise NoCrop(f"{f['detector']} found no {f['target']} on this picture.")
    if is_straighten(step):
        raise FlowError("A straightening step turns the picture; it has no plain rectangle.")
    w, h = (int(v) for v in step["size"])
    dx, dy = step["offset"]
    x0 = int(round(float(entry["x"]) + PIXEL_CENTRE + dx - w / 2))
    y0 = int(round(float(entry["y"]) + PIXEL_CENTRE + dy - h / 2))
    if x0 < 0 or y0 < 0 or x0 + w > width or y0 + h > height:
        raise NoCrop("The rectangle around the found target does not lie inside this picture.")
    return x0, y0, x0 + w, y0 + h


def follow_of(graph: dict, crop_id: str) -> dict | None:
    """``{detector, target}`` when the Crop is fed by one target of a detector (the arrow carries the target), else None."""
    for e in graph["edges"]:
        if e["target"] == crop_id and kind_of(e["source"]) == "detector" and e.get("point"):
            return {"detector": e["source"], "target": e["point"]}
    return None


def crop_mode(graph: dict, crop_id: str) -> str:
    node = graph["nodes"].get(crop_id) or {}
    return node.get("follow_mode") or (node.get("follow") or {}).get("mode", "keep")


def is_straighten(step: object) -> bool:
    return is_follow(step) and step["follow"].get("mode") == "straighten"


def has_turn(steps: list) -> bool:
    """True when a step turns the picture: boxes found behind it are in a turned picture."""
    return any(is_straighten(s) for s in steps)


def new_step_id(steps: list[dict]) -> str:
    taken = {str(s.get("id")) for s in steps}
    n = 1
    while f"s{n}" in taken:
        n += 1
    return f"s{n}"


def crop_steps(node: dict) -> list[dict]:
    """The picture edits of a Picture Edits (``crop``) box, in order. Boxes stored before the box held a list (a single
    ``rect``) read as one crop step."""
    if "steps" in node:
        return list(node["steps"])
    return [{"id": "s1", "op": "crop", "rect": node.get("rect")}]


def follow_step_id(graph: dict, node_id: str) -> str | None:
    """The step of a box fed by a detector target that follows the target: its first crop step (None when not fed, or
    when it has no crop step)."""
    if follow_of(graph, node_id) is None:
        return None
    node = graph["nodes"].get(node_id) or {}
    return next((s["id"] for s in crop_steps(node) if s["op"] == "crop"), None)


def _resolved(graph: dict, node_id: str) -> list[tuple[str, object]]:
    """``(step id, step as the picture functions read it)`` for each edit of the box; a crop with nothing drawn (or a
    following one with no rectangle yet) passes the picture on, so it is left out (``None``)."""
    node = graph["nodes"].get(node_id)
    if not node or node["kind"] != "crop":
        return []
    follow = follow_of(graph, node_id)
    fid = follow_step_id(graph, node_id)
    out: list[tuple[str, object]] = []
    for s in crop_steps(node):
        if s.get("enabled") is False:
            out.append((s["id"], None))  # switched off: the step keeps its place and is skipped when processing (v1.89.0)
        elif s["op"] == "filter":
            out.append((s["id"], {"filter": {"name": s["name"], "params": dict(s.get("params") or {})}}))
        elif follow and s["id"] == fid:
            spec = node.get("follow") or {}
            if not spec.get("size") or not spec.get("offset"):
                out.append((s["id"], None))
            else:
                out.append((s["id"], {"follow": {**follow, "mode": crop_mode(graph, node_id)}, "size": list(spec["size"]), "offset": list(spec["offset"])}))
        else:
            out.append((s["id"], s.get("rect") or None))
    return out


def own_steps(graph: dict, node_id: str) -> list:
    """What a Picture Edits box does to a picture, in order (see :func:`apply_rects`)."""
    return [r for _, r in _resolved(graph, node_id) if r is not None]


def steps_before(graph: dict, node_id: str, step_id: str, include: bool = False) -> list:
    """``input_rects`` of the box plus its own edits before ``step_id`` (through it when ``include``): the picture that
    enters that step (leaves it)."""
    rects = input_rects(graph, node_id)
    for sid, r in _resolved(graph, node_id):
        if sid == step_id:
            if include and r is not None:
                rects = rects + [r]
            return rects
        if r is not None:
            rects = rects + [r]
    raise FlowError(f"{node_id} has no step {step_id}.")


def input_rects(graph: dict, node_id: str) -> list:
    """The picture edits, outermost first, that turn a frame into the picture ``node_id`` works on (its input)."""
    parent = parent_of(graph, node_id)
    if parent is None or parent == INGEST_ID:
        return []
    if kind_of(parent) == "crop":
        return input_rects(graph, parent) + own_steps(graph, parent)
    if kind_of(parent) == "detector":
        return input_rects(graph, parent)  # a cascade (or a Crop that follows this detector) works in its input detector's picture
    return []


def output_rects(graph: dict, node_id: str) -> list:
    """``input_rects`` plus the box's own edits (a Picture Edits box's output picture)."""
    return input_rects(graph, node_id) + own_steps(graph, node_id)


GREY = 128  # what the corners of a straightened picture are filled with


def _straighten_matrix(step: dict, entry: dict) -> np.ndarray:
    """The 3x3 matrix (pixel indices) from the picture a straightening Crop reads to the picture it passes on: the
    picture is turned back by the found angle about the found target (``_straight_cut``'s convention) and the rectangle
    drawn relative to the target, in the target's own upright frame, is moved to the output's centre."""
    w, h = (int(v) for v in step["size"])
    dx, dy = step["offset"]
    tx, ty = float(entry["x"]), float(entry["y"])
    rot = np.vstack([cv2.getRotationMatrix2D((tx, ty), -float(entry.get("angle", 0.0)), 1.0), [0.0, 0.0, 1.0]])
    shift = np.array([[1.0, 0.0, (w - 1) / 2.0 - (tx + dx)], [0.0, 1.0, (h - 1) / 2.0 - (ty + dy)], [0.0, 0.0, 1.0]])
    return shift @ rot


def _straighten(image: np.ndarray, step: dict, entry: dict) -> np.ndarray:
    w, h = (int(v) for v in step["size"])
    return cv2.warpAffine(image, _straighten_matrix(step, entry)[:2], (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(GREY, GREY, GREY))


def apply_rects(image: np.ndarray, rects: list, found=None) -> tuple[np.ndarray, int, int]:
    """Cut ``image`` by each step in turn; also the pixel offset of the result inside the original picture (only
    meaningful while no step turns the picture, see :func:`rect_map`).
    ``found`` resolves the following steps on this picture (see :class:`Finder`); :class:`NoCrop` when one has no box."""
    ox = oy = 0
    for rect in rects:
        if is_filter(rect):
            image = preprocess.apply(image, rect["filter"]["name"], rect["filter"]["params"])
            continue
        if is_straighten(rect):
            entry = found(rect) if found else None
            if entry is None:
                f = rect["follow"]
                raise NoCrop(f"{f['detector']} found no {f['target']} on this picture.")
            image = _straighten(image, rect, entry)
            continue
        x0, y0, x1, y1 = step_box(rect, image.shape[1], image.shape[0], found)
        image = image[y0:y1, x0:x1]
        ox, oy = ox + x0, oy + y0
    return image, ox, oy


class Map:
    """Where the picture behind some Crop steps lies on the whole picture: ``m`` takes pixel indices of the cropped
    picture to indices of the whole one (a shift for a plain cut, a turn too for a straightening Crop), ``turn`` is
    how far (degrees, counter-clockwise on screen) the cropped picture is turned back relative to the whole one."""

    def __init__(self, m: np.ndarray | None = None, turn: float = 0.0) -> None:
        self.m = np.eye(3) if m is None else m
        self.turn = turn

    def point(self, x: float, y: float) -> tuple[float, float]:
        v = self.m @ np.array([float(x), float(y), 1.0])
        return float(v[0]), float(v[1])


def rect_map(rects: list, width: int, height: int, found=None) -> Map:
    """The :class:`Map` of the picture the steps ``rects`` cut from a ``width`` x ``height`` frame (no pixels needed)."""
    total = np.eye(3)
    turn = 0.0
    for rect in rects:
        if is_filter(rect):
            continue  # a filter changes pixels, not places
        if is_straighten(rect):
            entry = found(rect) if found else None
            if entry is None:
                f = rect["follow"]
                raise NoCrop(f"{f['detector']} found no {f['target']} on this picture.")
            total = total @ np.linalg.inv(_straighten_matrix(rect, entry))
            turn += float(entry.get("angle", 0.0))
            width, height = (int(v) for v in rect["size"])
            continue
        x0, y0, x1, y1 = step_box(rect, width, height, found)
        total = total @ np.array([[1.0, 0.0, x0], [0.0, 1.0, y0], [0.0, 0.0, 1.0]])
        width, height = x1 - x0, y1 - y0
    return Map(total, turn)


def rect_offset(rects: list, width: int, height: int, found=None) -> tuple[int, int]:
    """Where the cropped picture starts inside a ``width`` x ``height`` frame (no pixels needed)."""
    ox = oy = 0
    for rect in rects:
        if is_filter(rect):
            continue
        x0, y0, x1, y1 = step_box(rect, width, height, found)
        ox, oy, width, height = ox + x0, oy + y0, x1 - x0, y1 - y0
    return ox, oy


def _found_for(camera: str, rects: list, frame: str, finder: "Finder | None" = None):
    """The ``found`` function for ``frame`` (None when no step follows a detector)."""
    if not has_follow(rects):
        return None
    return (finder or Finder(camera)).for_frame(db.frame_hash_for(camera, frame))


def picture(camera: str, node_id: str, frame: str, stage: str = "input", straighten: bool = False, step: str | None = None, draft: object = None) -> np.ndarray:
    """The picture a box works on (``stage="input"``), or - for a Picture Edits box - the one it passes on (``"output"``).
    ``step`` (a step id of a Picture Edits box) narrows that to one edit: ``"input"`` is the picture entering the step,
    ``"output"`` the one leaving it. ``draft`` is a list of steps being edited and not saved yet: the box is read as if
    it held them (the live preview). ``straighten`` (the step that follows a target and straightens, ``stage="input"``):
    the same picture turned back by the found angle about the found target, whole and at the same size, so a rectangle
    can be drawn relative to the upright target."""
    graph = load_graph(camera)
    node = _node(graph, node_id)
    if draft is not None:
        if node["kind"] != "crop":
            raise FlowError("Only a Picture Edits box has steps.")
        graph["nodes"][node_id] = {**node, "steps": clean_steps(draft, follow_of(graph, node_id) is not None)}
    follow = follow_of(graph, node_id) if kind_of(node_id) == "crop" else None
    if straighten and follow and crop_mode(graph, node_id) == "straighten":
        step, stage = follow_step_id(graph, node_id), "input"
    if step is not None:
        rects = steps_before(graph, node_id, step, include=stage == "output")
    else:
        rects = output_rects(graph, node_id) if stage == "output" else input_rects(graph, node_id)
    image = apply_rects(_read(camera, frame), rects, _found_for(camera, rects, frame))[0]
    if straighten and follow and crop_mode(graph, node_id) == "straighten":
        entry = Finder(camera).box(follow["detector"], db.frame_hash_for(camera, frame), follow["target"])
        if entry is None:
            raise NoCrop(f"{follow['detector']} found no {follow['target']} on this picture.")
        rot = cv2.getRotationMatrix2D((float(entry["x"]), float(entry["y"])), -float(entry.get("angle", 0.0)), 1.0)
        image = cv2.warpAffine(image, rot, (image.shape[1], image.shape[0]), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(GREY, GREY, GREY))
    return image


def clean_steps(raw: object, following: bool = False) -> list[dict]:
    """The steps of a Picture Edits box from a request: a list of ``{"op": "crop", "rect": [x, y, w, h] | None}`` and
    ``{"op": "filter", "name": ..., "params": {...}}``, in the order they run; ``"enabled": false`` switches a step off
    (it keeps its place and is skipped). Ids are kept (or given); a filter's
    parameters are checked against the filter catalogue and completed with its defaults. A box fed by a detector target
    keeps at least one crop step: the first one follows the target."""
    if not isinstance(raw, (list, tuple)):
        raise FlowError("The steps are a list.")
    if len(raw) > MAX_STEPS:
        raise FlowError(f"A box holds at most {MAX_STEPS} steps.")
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict) or item.get("op") not in STEP_OPS:
            raise FlowError("A step is a crop or a filter.")
        sid = item.get("id")
        if not isinstance(sid, str) or not sid or len(sid) > 20 or any(o["id"] == sid for o in out):
            sid = new_step_id(out + [{"id": i["id"]} for i in raw if isinstance(i, dict) and isinstance(i.get("id"), str)])
        off = {"enabled": False} if item.get("enabled") is False else {}  # stored only when off, so boxes made before keep their signature
        if item["op"] == "crop":
            out.append({"id": sid, "op": "crop", "rect": clean_rect(item.get("rect")), **off})
            continue
        try:
            name = item.get("name")
            out.append({"id": sid, "op": "filter", "name": name, "params": preprocess.normalize(name, item.get("params")), **off})
        except preprocess.FilterError as exc:
            raise FlowError(str(exc)) from exc
    if following and not any(s["op"] == "crop" for s in out):
        raise FlowError("This box follows a target with its crop: disconnect the line to remove the crop step.")
    return out


def set_steps(node: dict, steps: list[dict]) -> None:
    node["steps"] = steps
    node.pop("rect", None)  # the single rectangle of the older Crop box lives in the first crop step now


# --- ids and graph ------------------------------------------------------------
def kind_of(node_id: str) -> str | None:
    if node_id == INGEST_ID:
        return "ingest"
    if node_id.startswith("classify:"):
        return "classify"
    return KIND_OF.get(node_id.split(":", 1)[0])


def is_flow_id(node_id: str) -> bool:
    return kind_of(node_id) in KINDS


def _renamed(node_id: str) -> str:
    return "eval:" + node_id[4:] if node_id.startswith("tol:") else node_id


def migrate_tolerance(camera: str, data: dict) -> dict:
    """The Tolerance box became the Evaluation box (v1.68.0): boxes ``tol:N`` become ``eval:N`` (kind ``evaluation``),
    in the graph, its arrows and the Chain layout. Done once, the first time an old graph is read."""
    nodes = {_renamed(i): ({**n, "kind": "evaluation"} if n.get("kind") == "tolerance" else n) for i, n in dict(data.get("nodes") or {}).items()}
    edges = [{**e, "source": _renamed(e["source"]), "target": _renamed(e["target"])} for e in list(data.get("edges") or [])]
    graph = {"nodes": nodes, "edges": edges}
    save_graph(camera, graph)
    raw = db.get_setting(camera, "chain.canvas")
    if raw and '"tol:' in raw:
        try:
            layout = json.loads(raw)
            layout["nodes"] = {_renamed(i): v for i, v in dict(layout.get("nodes") or {}).items()}
            db.set_setting(camera, "chain.canvas", json.dumps(layout, sort_keys=True))
        except (ValueError, TypeError, AttributeError):
            pass
    return graph


def load_graph(camera: str) -> dict:
    raw = db.get_setting(camera, GRAPH_KEY)
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                if any(i.startswith("tol:") for i in (data.get("nodes") or {})):
                    return migrate_tolerance(camera, data)
                return {"nodes": dict(data.get("nodes") or {}), "edges": list(data.get("edges") or [])}
        except (ValueError, TypeError):
            pass
    return {"nodes": {}, "edges": []}


def save_graph(camera: str, graph: dict) -> None:
    db.set_setting(camera, GRAPH_KEY, json.dumps(graph, sort_keys=True))


def _default_config(kind: str) -> dict:
    if kind == "crop":
        return {"steps": [{"id": "s1", "op": "crop", "rect": None}], "follow": None, "source": None}
    if kind == "detector":
        return {"targets": [], "angle_range": None, "rotate": True, "pad": DEFAULT_PAD, "source": None}
    if kind == "calc":
        return {"op": "angle", "a": None, "b": None, "clockwise": False}
    if kind == "dedup":
        return {"source": None}  # None: the whole camera (or the box a line comes from); else {"feature", "dot"} of a Classifier
    return {"nominal": None, "tolerance": 3.0, "zone": clean_zone(None)}


def clean_zone(raw: object, base: dict | None = None) -> dict:
    """The zone of an Evaluation box (pixels, relative to point A): a circle (centre, radius) or an upright rectangle
    (centre, half width and half height). ``raw`` may change only some fields; ``base`` is what it changes."""
    zone = {**DEFAULT_ZONE, **(base or {})}
    zone["half"] = list(zone["half"])
    if raw is None:
        return zone
    if not isinstance(raw, dict):
        raise FlowError("The zone must be an object.")
    if "shape" in raw:
        if raw["shape"] not in ZONE_SHAPES:
            raise FlowError("The zone is a circle or a rectangle.")
        zone["shape"] = raw["shape"]
    if "center" in raw:
        c = raw["center"]
        if c is None:
            zone["center"] = None
        elif isinstance(c, (list, tuple)) and len(c) == 2:
            zone["center"] = [_finite(c[0], "Zone centre"), _finite(c[1], "Zone centre")]
        else:
            raise FlowError("The zone centre is a pair of numbers (dx, dy).")
    if "radius" in raw:
        radius = _finite(raw["radius"], "Radius")
        if radius <= 0:
            raise FlowError("The radius must be greater than zero.")
        zone["radius"] = radius
    if "half" in raw:
        h = raw["half"]
        if not (isinstance(h, (list, tuple)) and len(h) == 2):
            raise FlowError("The rectangle size is a pair of half width and half height.")
        half = [_finite(h[0], "Half width"), _finite(h[1], "Half height")]
        if half[0] <= 0 or half[1] <= 0:
            raise FlowError("The half width and half height must be greater than zero.")
        zone["half"] = half
    return zone


def zone_of(node: dict) -> dict:
    """An Evaluation box's zone; boxes saved before the zone existed get the default."""
    return clean_zone(None, node.get("zone"))


def create_node(camera: str, kind: str) -> str:
    if kind not in KINDS:
        raise FlowError(f"Unknown box kind: {kind}")
    graph = load_graph(camera)
    n = 1
    while f"{PREFIX[kind]}:{n}" in graph["nodes"]:
        n += 1
    node_id = f"{PREFIX[kind]}:{n}"
    graph["nodes"][node_id] = {"kind": kind, **_default_config(kind)}
    # No line is drawn for a new box (v1.88.0): every connection is made by the user. A picture box with no line
    # reads the whole picture, like one fed by Ingest.
    save_graph(camera, graph)
    return node_id


def _node(graph: dict, node_id: str) -> dict:
    node = graph["nodes"].get(node_id)
    if node is None:
        raise FlowError(f"Unknown box: {node_id}")
    return node


def parent_of(graph: dict, node_id: str) -> str | None:
    for e in graph["edges"]:
        if e["target"] == node_id and kind_of(e["source"]) in ("ingest", "crop", "detector", "calc"):
            return e["source"]
    return None


def children_of(graph: dict, node_id: str) -> list[str]:
    return [e["target"] for e in graph["edges"] if e["source"] == node_id]


def edge_allowed(graph: dict, source: str, target: str) -> str | None:
    """None when the arrow fits, else the reason it does not."""
    ks, kt = kind_of(source), kind_of(target)
    if source == target:
        return "A box cannot feed itself."
    why = lines.line_error(ks, kt)
    if why:
        return why
    if (ks, kt) not in {("ingest", "crop"), ("crop", "crop"), ("crop", "detector"), ("ingest", "detector"), ("detector", "detector"), ("detector", "crop"), ("detector", "calc"), ("calc", "evaluation"), ("evaluation", "classify"), ("ingest", "dedup"), ("crop", "dedup"), ("detector", "dedup")}:
        if ks == "dedup":
            return "A Dedup box feeds a Classifier. Lines from it to Picture edits or a detector are not made yet."
        names = {"ingest": "Ingest", "crop": "Picture edits", "detector": "a detector", "calc": "Calculate", "evaluation": "Evaluation", "classify": "a Classify box", "dedup": "a Dedup box"}
        return f"{names.get(ks, ks)} cannot feed {names.get(kt, kt)}."
    if is_flow_id(source) and source not in graph["nodes"]:
        return f"Unknown box: {source}"
    if is_flow_id(target) and target not in graph["nodes"]:
        return f"Unknown box: {target}"
    if kt in ("crop", "detector") and ks in ("crop", "detector"):
        ancestor = source
        while ancestor and ancestor != INGEST_ID:
            if ancestor == target:
                return "That would make a loop."
            ancestor = parent_of(graph, ancestor)
    return None


def connect(camera: str, source: str, target: str, point: str | None = None) -> None:
    """Store an arrow. ``point`` (a detector -> Calculate arrow only) names the one target the arrow carries;
    without it the arrow carries the whole detector."""
    graph = load_graph(camera)
    reason = edge_allowed(graph, source, target)
    if reason:
        raise FlowError(reason)
    if kind_of(source) == "detector" and kind_of(target) == "crop" and point is None:
        raise FlowError("A Picture edits box follows one target of a detector: draw the arrow from that target's dot.")
    if kind_of(source) == "detector" and kind_of(target) == "dedup" and point is None:
        raise FlowError("A Dedup box reads the box a detector found for one target: draw the arrow from that target's dot.")
    if point is not None:
        if kind_of(source) != "detector" or kind_of(target) not in ("calc", "crop", "dedup"):
            raise FlowError("Only a detector's target can feed one point of a Calculate box, a Picture edits box or a Dedup box.")
        if point not in [t["name"] for t in graph["nodes"][source]["targets"]]:
            raise FlowError(f"{source} has no target {point}.")
    edge = {"source": source, "target": target, **({"point": point} if point is not None else {})}
    if kind_of(target) == "calc":
        # Several arrows feed a Calculate box (the whole detector or single targets), two points in all.
        before = calc_points(graph, target)
        graph["edges"] = [e for e in graph["edges"] if not (e["source"] == source and e["target"] == target and e.get("point") == point)]
        graph["edges"].append(edge)
        after = calc_points(graph, target)
        if len(before) >= 2 and len(after) > len(before):
            raise FlowError("Calculate takes two points. Delete a line into it first.")
    elif kind_of(target) in ("evaluation", "crop", "detector", "dedup"):
        # One input per box: a new arrow replaces the old one.
        before_follow = follow_of(graph, target) if kind_of(target) == "crop" else None
        graph["edges"] = [e for e in graph["edges"] if e["target"] != target]
        graph["edges"].append(edge)
        if kind_of(target) in ("dedup", "crop", "detector"):
            graph["nodes"][target]["source"] = None  # one input: a line from Ingest or Picture edits replaces a Classifier dot
        if kind_of(target) == "crop" and follow_of(graph, target) != before_follow:
            graph["nodes"][target]["follow"] = None  # the rectangle was drawn for another target
        if kind_of(target) == "crop" and follow_of(graph, target) is not None:
            node = graph["nodes"][target]
            steps = crop_steps(node)
            if not any(st["op"] == "crop" for st in steps):
                set_steps(node, steps + [{"id": new_step_id(steps), "op": "crop", "rect": None}])  # the step that follows the target
    else:
        if kind_of(target) == "classify":
            graph["edges"] = [e for e in graph["edges"] if not (e["source"] == source and e["target"] == target)]
        graph["edges"].append(edge)
    save_graph(camera, graph)


def disconnect(camera: str, source: str, target: str, point: str | None = None) -> None:
    graph = load_graph(camera)
    kept = [e for e in graph["edges"] if not (e["source"] == source and e["target"] == target and e.get("point") == point)]
    if len(kept) == len(graph["edges"]):
        raise FlowError("There is no such arrow.")
    graph["edges"] = kept  # a picture box with no arrow reads the whole picture, like one fed by Ingest
    if kind_of(target) == "crop" and target in graph["nodes"] and follow_of(graph, target) is None:
        graph["nodes"][target]["follow"] = None
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
        **({"mutes": len(db.muted_frames(camera, node_id))} if kind_of(node_id) == "dedup" else {}),
    }


def delete_node(camera: str, node_id: str) -> None:
    graph = load_graph(camera)
    _node(graph, node_id)
    del graph["nodes"][node_id]
    graph["edges"] = [e for e in graph["edges"] if node_id not in (e["source"], e["target"])]
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


def _follow_settings(camera: str, graph: dict, crop_id: str, follow: dict, raw: object) -> dict | None:
    """Size and offset of a following Crop from a rectangle drawn on a picture where the detector found the target.
    ``raw`` is ``{"frame": name, "rect": [x, y, w, h]}`` in pixels of the Crop's input picture (the picture the
    detector works on), or None to forget the rectangle."""
    if raw is None:
        return None
    if not isinstance(raw, dict) or "frame" not in raw or "rect" not in raw:
        raise FlowError("Send the picture and the rectangle drawn on it.")
    rect = raw["rect"]
    if not isinstance(rect, (list, tuple)) or len(rect) != 4:
        raise FlowError("The rectangle is x, y, width, height.")
    x, y, w, h = (_finite(v, "The rectangle") for v in rect)
    w, h = int(round(w)), int(round(h))
    if w < 2 or h < 2:
        raise FlowError("The rectangle is too small.")
    frame = str(raw["frame"])
    key = db.frame_hash_for(camera, frame)
    entry = Finder(camera).box(follow["detector"], key, follow["target"]) if key else None
    if entry is None:
        raise FlowError(f"{follow['detector']} has not found {follow['target']} on {frame}; draw the rectangle on a picture where it did.")
    fid = follow_step_id(graph, crop_id)
    rects = steps_before(graph, crop_id, fid) if fid else input_rects(graph, crop_id)  # the picture that enters the step that follows
    image = apply_rects(_read(camera, frame), rects, _found_for(camera, rects, frame))[0]
    if x < -0.5 or y < -0.5 or x + w > image.shape[1] + 0.5 or y + h > image.shape[0] + 0.5:
        raise FlowError("The rectangle must lie inside the picture.")
    return {
        "mode": "keep",
        "frame": frame,
        "size": [w, h],
        "offset": [round(x + w / 2 - (float(entry["x"]) + PIXEL_CENTRE), 2), round(y + h / 2 - (float(entry["y"]) + PIXEL_CENTRE), 2)],
    }


def update_node(camera: str, node_id: str, raw: dict) -> dict:
    """Change the settings of a box. Targets and examples of a detector have their own calls."""
    graph = load_graph(camera)
    node = _node(graph, node_id)
    kind = node["kind"]
    if kind in ("crop", "detector") and "source" in raw:
        node["source"] = _dedup_source(camera, node_id, raw["source"])
        if node["source"]:
            graph["edges"] = [e for e in graph["edges"] if e["target"] != node_id]  # one input: the Classifier dot replaces the line
            if kind == "crop":
                node["follow"] = None  # a following rectangle was drawn for a detector target
    if kind == "crop":
        follow = follow_of(graph, node_id)
        if "steps" in raw:
            steps = clean_steps(raw["steps"], follow is not None)
            if follow:
                fid = follow_step_id(graph, node_id)
                new_fid = next((st["id"] for st in steps if st["op"] == "crop"), None)
                if new_fid != fid:
                    node["follow"] = None  # another crop step follows the target now: its rectangle is drawn again
            set_steps(node, steps)
        if "rect" in raw:  # the single rectangle of the older Crop box: the first crop step's
            if follow:
                raise FlowError("This crop step follows a target: draw its rectangle on a picture where the target was found.")
            steps = crop_steps(node)
            rect = clean_rect(raw["rect"])
            first = next((st for st in steps if st["op"] == "crop"), None)
            if first is None:
                steps = steps + [{"id": new_step_id(steps), "op": "crop", "rect": rect}]
            else:
                first["rect"] = rect
            set_steps(node, steps)
        if "follow_mode" in raw:
            if not follow:
                raise FlowError("Connect one target of a detector to this Picture edits box first.")
            if raw["follow_mode"] not in FOLLOW_MODES:
                raise FlowError("Unknown way to follow a target.")
            detail_modes = {m["id"]: m for m in follow_detail(camera, graph, node_id)["modes"]}
            if not detail_modes[raw["follow_mode"]]["enabled"]:
                raise FlowError(f"Tick {', '.join(detail_modes[raw['follow_mode']]['needs'])} on {follow['detector']} for {follow['target']} first.")
            if crop_mode(graph, node_id) != raw["follow_mode"]:
                node["follow"] = None  # the rectangle's offset means another thing in the other mode: draw it again
            node["follow_mode"] = raw["follow_mode"]
        if "follow" in raw:
            if not follow:
                raise FlowError("Connect one target of a detector to this Picture edits box first.")
            node["follow"] = _follow_settings(camera, graph, node_id, follow, raw["follow"])
    elif kind == "detector":
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
    elif kind == "dedup":
        if "source" in raw:
            node["source"] = _dedup_source(camera, node_id, raw["source"])
            if node["source"]:
                graph["edges"] = [e for e in graph["edges"] if e["target"] != node_id]  # one input: the Classifier dot replaces the line
    else:
        if "nominal" in raw:
            node["nominal"] = None if raw["nominal"] is None else _finite(raw["nominal"], "Nominal")
        if "tolerance" in raw:
            tolerance = _finite(raw["tolerance"], "Tolerance")
            if tolerance <= 0:
                raise FlowError("The tolerance must be greater than zero.")
            node["tolerance"] = tolerance
        if "zone" in raw:
            node["zone"] = clean_zone(raw["zone"], node.get("zone"))
    save_graph(camera, graph)
    return node


def _dedup_source(camera: str, node_id: str, raw: object) -> dict | None:
    """The Classifier dot a Dedup box reads: ``None`` (the whole camera) or ``{"feature", "dot"}``."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise FlowError("The source of a Dedup box is a Classifier and one of its dots.")
    feature, dot = str(raw.get("feature") or ""), str(raw.get("dot") or "")
    roi = datamodel.get_roi(camera, feature)
    if roi is None:
        raise FlowError(f"Unknown ROI: {feature}")
    if dot != lines.ALL_DOT and dot not in datamodel.classes_for(camera, feature):
        raise FlowError(f"{feature} has no class {dot}.")
    if db.get_setting(camera, f"{db.DEDUP_INPUT_KEY}{feature}") == node_id:
        raise FlowError(f"{node_id} feeds {feature}, so it cannot read it.")
    return {"feature": feature, "dot": dot}


def parent_target_names(graph: dict, node_id: str) -> list[str]:
    """The targets (with examples) of the detector this one reads: the boxes a cascaded target can search inside."""
    parent = parent_of(graph, node_id)
    if not parent or kind_of(parent) != "detector" or parent not in graph["nodes"]:
        return []
    return [t["name"] for t in graph["nodes"][parent]["targets"] if t["examples"]]


def _clean_inside(graph: dict, node_id: str, inside: object) -> str | None:
    """``inside`` is the input detector's target a cascaded target searches in; None outside a cascade or for "same name"."""
    if inside in (None, ""):
        return None
    names = parent_target_names(graph, node_id)
    if inside not in names:
        raise FlowError("A target can only search inside a target of the detector before this one." if not names
                        else f"The detector before this one has no target named {inside}.")
    return str(inside)


def inside_of(target: dict) -> str:
    """The input detector's target whose box this target searches in (before v1.73.0 always the same name)."""
    return target.get("inside") or target["name"]


def add_target(camera: str, node_id: str, name: str, inside: str | None = None) -> None:
    graph = load_graph(camera)
    node = _node(graph, node_id)
    if node["kind"] != "detector":
        raise FlowError("Only a detector has targets.")
    name = _name(name, "A target")
    if any(t["name"] == name for t in node["targets"]):
        raise FlowError(f"There is already a target named {name}.")
    if len(node["targets"]) >= MAX_TARGETS:
        raise FlowError(f"A detector can have at most {MAX_TARGETS} targets.")
    node["targets"].append({"name": name, "examples": [], "inside": _clean_inside(graph, node_id, inside), "outputs": list(DEFAULT_OUTPUTS)})
    save_graph(camera, graph)


#: What a detector target can offer the next box. Position is on by default (and can be turned off); the angle and the
#: size of the found box are stored for every found box, but only reach a box downstream when the target offers them.
OUTPUTS = {"position": "Position", "angle": "Angle", "size": "Size"}
DEFAULT_OUTPUTS = ["position"]

#: How a Crop can use the target it follows: the outputs the mode needs, and what it does. More modes (Straighten
#: needs the angle) are added here; a mode whose outputs the target does not offer is shown greyed out.
FOLLOW_MODES = {
    "keep": {"label": "Position only: the picture stays upright", "needs": ["position"]},
    "straighten": {"label": "Position and angle: the picture is straightened", "needs": ["position", "angle"]},
}


def outputs_of(target: dict) -> list[str]:
    """The outputs a target offers, in a fixed order (targets stored before v1.80.0 offer the position only)."""
    stored = target.get("outputs", DEFAULT_OUTPUTS)
    return [o for o in OUTPUTS if o in stored]


def _output_users(graph: dict, node_id: str, name: str, output: str) -> list[str]:
    """The boxes fed by this target's line that read ``output``: every line reads the position; a Crop that
    straightens the picture reads the angle too."""
    lines = [e["target"] for e in graph["edges"] if e["source"] == node_id and e.get("point") == name]
    if output == "position":
        return lines
    return [b for b in lines if kind_of(b) == "crop" and output in FOLLOW_MODES.get(crop_mode(graph, b), {}).get("needs", [])]


def set_target_outputs(camera: str, node_id: str, name: str, outputs: object) -> None:
    graph = load_graph(camera)
    node = _node(graph, node_id)
    entry = next((t for t in node.get("targets", []) if t["name"] == name), None)
    if entry is None:
        raise FlowError(f"Unknown target: {name}")
    if not isinstance(outputs, (list, tuple)) or any(o not in OUTPUTS for o in outputs):
        raise FlowError(f"The outputs are some of: {', '.join(OUTPUTS)}.")
    wanted = [o for o in OUTPUTS if o in outputs]
    for output in OUTPUTS:
        users = _output_users(graph, node_id, name, output) if output not in wanted else []
        if users:
            raise FlowError(f"{', '.join(users)} read the {output} of {name}. " + ("Delete its line first." if output == "position" else "Change its use of the target first."))
    entry["outputs"] = wanted
    save_graph(camera, graph)


def set_target_inside(camera: str, node_id: str, name: str, inside: str | None) -> None:
    """Change which target of the input detector this target searches inside (the detector then needs a new run)."""
    graph = load_graph(camera)
    node = _node(graph, node_id)
    entry = next((t for t in node.get("targets", []) if t["name"] == name), None)
    if entry is None:
        raise FlowError(f"Unknown target: {name}")
    entry["inside"] = _clean_inside(graph, node_id, inside)
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


def clean_angle(raw: object) -> float:
    """A turn in degrees, counter-clockwise as seen on screen, brought to -180..180."""
    return round(((_finite(raw, "The turn") + 180.0) % 360.0) - 180.0, 2)


def _straight_cut(image: np.ndarray, x: int, y: int, w: int, h: int, angle: float) -> np.ndarray:
    """The ``w`` x ``h`` content of a rectangle with its centre at the centre of ``[x, y, w, h]`` and turned by ``angle``
    (counter-clockwise on screen), turned back upright. What lies outside the picture repeats its edge."""
    cx, cy = x + w / 2.0 - 0.5, y + h / 2.0 - 0.5  # pixel indices
    m = cv2.getRotationMatrix2D((cx, cy), -angle, 1.0)
    m[0, 2] += (w - 1) / 2.0 - cx
    m[1, 2] += (h - 1) / 2.0 - cy
    return cv2.warpAffine(image, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def _cut(camera: str, frame: str, box: list[float], rects: list | None = None, angle: float = 0.0) -> tuple[list[int], str, float]:
    """The example crop of ``box`` (pixels ``[x, y, w, h]`` of the picture the detector works on, after any Crop boxes
    above it) on ``frame``: the clipped box, the crop as base64 PNG and the scale it is stored at. With an ``angle`` the
    rectangle is turned about its centre and cut upright (the box stays the unturned one, centre inside the picture).
    A crop whose longer side is over ``MAX_EXAMPLE_SIDE`` is stored shrunk (scale < 1, the box stays in picture pixels);
    ``run_detector`` then searches a picture shrunk by the same factor."""
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise FlowError("The example box is x, y, width, height.")
    image = apply_rects(_read(camera, frame), rects or [], _found_for(camera, rects or [], frame))[0]
    x, y, w, h = (int(round(_finite(v, "Box"))) for v in box)
    if angle:
        if w < 5 or h < 5:
            raise FlowError("The example is too small; draw a larger box.")
        if not (0 <= x + w / 2.0 <= image.shape[1] and 0 <= y + h / 2.0 <= image.shape[0]):
            raise FlowError("The centre of the turned rectangle must lie on the picture.")
        crop = _straight_cut(image, x, y, w, h, angle)
        clipped = [x, y, w, h]
    else:
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(image.shape[1], x + w), min(image.shape[0], y + h)
        if x1 - x0 < 5 or y1 - y0 < 5:
            raise FlowError("The example is too small; draw a larger box.")
        crop = image[y0:y1, x0:x1]
        clipped = [x0, y0, x1 - x0, y1 - y0]
    if float(np.std(crop)) < rotsearch.MIN_TEXTURE:
        raise FlowError("The example is flat; there is nothing to recognise in it.")
    scale = min(1.0, MAX_EXAMPLE_SIDE / float(max(crop.shape[1], crop.shape[0])))
    stored = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1.0 else crop
    ok, buf = cv2.imencode(".png", stored)
    if not ok:
        raise FlowError("Cannot store the example.")
    return clipped, base64.b64encode(buf.tobytes()).decode(), scale


def _store_cut(example: dict, png: str, scale: float) -> None:
    """Put a cut into an example. ``scale`` is kept only when the crop was shrunk, so examples (and the signature of
    detectors) that never needed it stay exactly as they were before v1.75.0."""
    example["png"] = png
    if scale < 1.0:
        example["scale"] = round(scale, 6)
    else:
        example.pop("scale", None)


def match_scale(node: dict) -> float:
    """The factor a detector shrinks its picture and examples by: the smallest scale any of its examples was stored
    at, so the largest example is matched at ``MAX_EXAMPLE_SIDE`` and nothing is ever enlarged. 1 for a detector whose
    examples all fit."""
    return min((float(e.get("scale", 1.0)) for t in node.get("targets", []) for e in t["examples"]), default=1.0)


def _check_scale(node: dict) -> None:
    """Refuse an example that would make another one of the detector too small to match once the picture is shrunk."""
    scale = match_scale(node)
    if scale >= 1.0:
        return
    for t in node["targets"]:
        for e in t["examples"]:
            if min(e["box"][2], e["box"][3]) * scale < MIN_MATCH_SIDE:
                raise FlowError(
                    f"This example is too large next to a small one of this detector: the picture is shrunk to fit "
                    f"{MAX_EXAMPLE_SIDE} px and the small example would drop under {MIN_MATCH_SIDE} px. "
                    "Draw a smaller part of the large object, or use another detector for it."
                )


def add_example(camera: str, node_id: str, target: str, frame: str, box: list[float], angle: float = 0.0) -> dict:
    """Cut an example crop (pixels ``[x, y, w, h]`` of the frame) and keep it with the target. A rectangle turned by
    ``angle`` (counter-clockwise on screen) is cut upright, so the example shows the part the way it sits in its own
    frame whatever its turn in this picture."""
    graph = load_graph(camera)
    node = _node(graph, node_id)
    if node["kind"] != "detector":
        raise FlowError("Only a detector has examples.")
    entry = next((t for t in node["targets"] if t["name"] == target), None)
    if entry is None:
        raise FlowError(f"Unknown target: {target}")
    if len(entry["examples"]) >= MAX_EXAMPLES:
        raise FlowError(f"A target can have at most {MAX_EXAMPLES} examples.")
    turn = clean_angle(angle) if angle else 0.0
    clipped, png, scale = _cut(camera, frame, box, input_rects(graph, node_id), turn)
    example = {"frame": frame, "box": clipped}
    if turn:
        example["angle"] = turn  # kept so the rectangle is drawn turned; the stored crop is already upright
    _store_cut(example, png, scale)
    entry["examples"].append(example)
    _check_scale(node)
    save_graph(camera, graph)
    return example


def update_example(camera: str, node_id: str, target: str, index: int, box: list[float], angle: float | None = None) -> dict:
    """Move or resize an example rectangle on its own picture; the crop is cut again (the detector then needs a new run)."""
    graph = load_graph(camera)
    node = _node(graph, node_id)
    entry = next((t for t in node.get("targets", []) if t["name"] == target), None)
    if entry is None or not 0 <= index < len(entry["examples"]):
        raise FlowError("There is no such example.")
    example = entry["examples"][index]
    turn = example.get("angle", 0.0) if angle is None else (clean_angle(angle) if angle else 0.0)
    example["box"], png, scale = _cut(camera, example["frame"], box, input_rects(graph, node_id), turn)
    if turn:
        example["angle"] = turn
    else:
        example.pop("angle", None)
    _store_cut(example, png, scale)
    _check_scale(node)
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
        "targets": [(t["name"], [(e["png"], e["scale"]) if "scale" in e else e["png"] for e in t["examples"]]) + ((t["inside"],) if t.get("inside") else ()) for t in node["targets"]],
        "rotate": node["rotate"],
        "range": node["angle_range"],
        "pad": node["pad"],
        "crops": [{**c, "sig": signature(graph, c["follow"]["detector"])} if is_follow(c) and c["follow"]["detector"] in graph["nodes"] else c for c in input_rects(graph, node_id)],
        "parent": signature(graph, parent) if parent and kind_of(parent) == "detector" else None,
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


def node_source(graph: dict, node_id: str) -> dict | None:
    """``{"feature", "dot"}`` when a Picture edits or detector box reads one dot of a Classifier (v1.98.0), else ``None``."""
    src = (graph["nodes"].get(node_id) or {}).get("source")
    return src if isinstance(src, dict) and src.get("feature") and src.get("dot") else None


def node_frames(camera: str, node_id: str, graph: dict | None = None) -> list[str]:
    """The pictures a box works on: the pictures on its Classifier dot, or the whole camera when no dot feeds it.
    Deleted and removed pictures never; a class that went away gives none."""
    src = node_source(graph or load_graph(camera), node_id)
    if not src:
        return _live_frames(camera)
    try:
        names = lines.frames_on_dot(camera, src["feature"], src["dot"])
    except ValueError:
        return []
    live = set(_live_frames(camera))
    return [f for f in names if f in live]


def _match_entry(match: rotsearch.Match, source: str = "auto", scale: float = 1.0, size: tuple[int, int] | None = None) -> dict:
    """A stored box. ``scale`` < 1 means the match was made on a picture shrunk by it: the centre is taken back to
    the picture's own pixels and ``size`` is the example's own (unshrunk) width and height."""
    x, y = float(match.x), float(match.y)
    if scale < 1.0:
        x, y = (x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5
    w, h = size if size is not None else (match.w, match.h)
    return {
        "x": round(x, 2),
        "y": round(y, 2),
        "angle": round(float(match.angle), 2),
        "score": round(float(match.score), 3),
        "w": int(w),
        "h": int(h),
        "source": source,
    }


def _search_example(example: dict, scale: float) -> tuple[np.ndarray, tuple[int, int]]:
    """An example as the detector matches it: its stored crop, shrunk further when it was stored at a larger scale
    than the detector's ``scale``; and its own size in picture pixels."""
    image = _example_image(example)
    factor = scale / float(example.get("scale", 1.0))
    if factor < 1.0 - 1e-9:
        image = cv2.resize(image, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
    return image, (int(example["box"][2]), int(example["box"][3]))


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
        if kind_of(node_id) == "detector":
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
    if parent and kind_of(parent) != "detector":
        parent = None  # Ingest or a Crop: the whole (cropped) picture is searched
    parent_frames: dict = {}
    rects = input_rects(graph, node_id)
    for step in rects:
        if is_follow(step) and status(camera, step["follow"]["detector"], graph) != "fresh":
            raise FlowError(f"Run {step['follow']['detector']} first; the Picture edits box before this detector follows its boxes.")
    finder = Finder(camera)
    if parent:
        if status(camera, parent, graph) != "fresh":
            raise FlowError("Run the detector before this one first; its boxes are the search areas here.")
        parent_frames = load_stored(camera, parent)["frames"]
    scale = match_scale(node)  # < 1 when an example was too large to match as it is: the picture shrinks with it
    examples = {t["name"]: [_search_example(e, scale) for e in t["examples"]] for t in usable}
    inside_names = {t["name"]: inside_of(t) for t in usable}  # the input detector's target each one searches in
    angle_range = tuple(node["angle_range"]) if node["angle_range"] else None
    if not node["rotate"]:
        angle_range = (0.0, 0.0)
    previous = load_stored(camera, node_id)["frames"]
    hmap = labels.hash_map(camera)
    names = frames if frames is not None else node_frames(camera, node_id, graph)
    out: dict[str, dict] = {}
    import curation  # noqa: PLC0415

    for i, frame in enumerate(names, 1):
        key = hmap.get(frame)
        if key:
            old = previous.get(key, {})
            found: dict[str, dict] = {n: e for n, e in old.items() if e.get("source") == "human"}
            try:
                picture = apply_rects(curation.load_image(datamodel.unsorted_dir(camera) / frame), rects, finder.for_frame(key) if has_follow(rects) else None)[0]
            except Exception:  # noqa: BLE001 - an unreadable frame, or one a following Crop has no rectangle on, has no boxes
                picture = None
            if picture is not None:
                searched = cv2.resize(picture, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1.0 else picture
                for name, imgs in examples.items():
                    if name in found:
                        continue
                    region = None
                    if parent:
                        inside = parent_frames.get(key, {}).get(inside_names[name])
                        if inside is None:
                            continue
                        region = _as_match(inside).region(picture.shape, node["pad"])
                        if scale < 1.0:
                            region = (int(math.floor(region[0] * scale)), int(math.floor(region[1] * scale)),
                                      int(math.ceil(region[2] * scale)) + 1, int(math.ceil(region[3] * scale)) + 1)
                    best: tuple[rotsearch.Match, tuple[int, int]] | None = None
                    for image, size in imgs:  # the best match over this target's examples
                        match = rotsearch.find(searched, image, angle_range=angle_range, region=region)
                        if match is not None and (best is None or match.score > best[0].score):
                            best = (match, size)
                    if best is not None:
                        found[name] = _match_entry(best[0], scale=scale, size=best[1])
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
    for frame in node_frames(camera, node_id):
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
def _detector_targets(graph: dict, detector: str) -> list[str]:
    if detector not in graph["nodes"]:
        return []
    return [t["name"] for t in graph["nodes"][detector]["targets"] if t["examples"]]


def calc_points(graph: dict, calc_id: str) -> list[tuple[str, str]]:
    """The (detector, target) points the arrows into a Calculate box carry, in arrow order: an arrow from a whole
    detector carries all its targets that have examples, an arrow from one target dot carries that target."""
    out: list[tuple[str, str]] = []
    for e in graph["edges"]:
        if e["target"] != calc_id or kind_of(e["source"]) != "detector":
            continue
        names = _detector_targets(graph, e["source"])
        for name in ([e["point"]] if e.get("point") in names else [] if e.get("point") else names):
            if (e["source"], name) not in out:
                out.append((e["source"], name))
    return out


def point_keys(graph: dict, calc_id: str) -> dict[str, tuple[str, str]]:
    """Point key -> (detector, target). The key is the target name, or ``det:N/name`` when two detectors share a name."""
    points = calc_points(graph, calc_id)
    names = [name for _, name in points]
    return {(name if names.count(name) == 1 else f"{det}/{name}"): (det, name) for det, name in points}


def point_names(graph: dict, calc_id: str) -> list[str]:
    return list(point_keys(graph, calc_id))


def effective_points(graph: dict, calc_id: str) -> tuple[str | None, str | None]:
    """The two points a Calculate box uses: its choice, else the first two points its arrows carry."""
    node = graph["nodes"][calc_id]
    names = point_names(graph, calc_id)
    a = node["a"] if node["a"] in names else (names[0] if names else None)
    b = node["b"] if node["b"] in names else next((n for n in names if n != a), None)
    return a, b


def calc_detector(graph: dict, calc_id: str) -> str | None:
    """The one detector both points come from, or None when they come from different detectors (or are missing)."""
    keys = point_keys(graph, calc_id)
    a, b = effective_points(graph, calc_id)
    sources = {keys[k][0] for k in (a, b) if k in keys}
    return sources.pop() if len(sources) == 1 and a and b else None


def _frame_sizes(camera: str) -> dict[str, tuple[int, int]]:
    """Picture size by frame hash (headers only)."""
    from PIL import Image  # noqa: PLC0415

    sizes: dict[str, tuple[int, int]] = {}
    for name, key in labels.hash_map(camera).items():
        if key not in sizes:
            try:
                with Image.open(datamodel.unsorted_dir(camera) / name) as im:
                    sizes[key] = im.size
            except Exception:  # noqa: BLE001 - an unreadable frame has no size, so no value
                continue
    return sizes


def compute(op: str, a: tuple[float, float], b: tuple[float, float], clockwise: bool = False) -> float:
    """The measure from point A to point B, picture coordinates (y points down).

    ``angle``: 0 deg points right; positive turns counter-clockwise on screen unless ``clockwise``; 0-360."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    if op == "dx":
        return dx
    if op == "dy":
        return dy
    if op in ("distance", "offset"):  # an offset is a pair (dx, dy); as one number it is its length
        return math.hypot(dx, dy)
    if op == "angle":
        value = math.degrees(math.atan2(dy if clockwise else -dy, dx))
        return value % 360.0
    raise FlowError(f"Unknown operation: {op}")


def _calc_pairs(camera: str, calc_id: str, graph: dict) -> dict[str, tuple[tuple[float, float], tuple[float, float]] | None]:
    """Points A and B by frame hash on the whole picture (None when a point is missing). The two points may come from
    different detectors; each is moved by the offset of the crops above its detector."""
    keys = point_keys(graph, calc_id)
    a, b = effective_points(graph, calc_id)
    if a is None or b is None:
        return {}
    (det_a, name_a), (det_b, name_b) = keys[a], keys[b]
    stored_a = load_stored(camera, det_a)["frames"]
    stored_b = stored_a if det_b == det_a else load_stored(camera, det_b)["frames"]
    rects_a, rects_b = input_rects(graph, det_a), input_rects(graph, det_b)
    turned = has_turn(rects_a) or has_turn(rects_b)  # the points must be measured on the whole picture, not in a turned one
    sizes = _frame_sizes(camera) if rects_a != rects_b or turned else {}
    finder = Finder(camera)

    def _found(rects: list, key: str):
        return finder.for_frame(key) if has_follow(rects) else None

    pairs: dict[str, tuple[tuple[float, float], tuple[float, float]] | None] = {}
    for key in dict.fromkeys([*stored_a, *stored_b]):
        box_a, box_b = stored_a.get(key, {}).get(name_a), stored_b.get(key, {}).get(name_b)
        if not box_a or not box_b:
            pairs[key] = None
            continue
        pa, pb = (box_a["x"], box_a["y"]), (box_b["x"], box_b["y"])
        if rects_a != rects_b or turned:
            if key not in sizes:
                pairs[key] = None
                continue
            try:
                map_a, map_b = (rect_map(r, *sizes[key], found=_found(r, key)) for r in (rects_a, rects_b))
            except NoCrop:
                pairs[key] = None
                continue
            pa, pb = map_a.point(*pa), map_b.point(*pb)
        pairs[key] = (pa, pb)
    return pairs


def calc_values(camera: str, calc_id: str, graph: dict | None = None) -> dict[str, float | None]:
    """The measured number by frame hash (None when a point is missing), measured on the whole picture."""
    graph = graph or load_graph(camera)
    node = _node(graph, calc_id)
    return {k: (None if p is None else compute(node["op"], p[0], p[1], node["clockwise"])) for k, p in _calc_pairs(camera, calc_id, graph).items()}


def calc_offsets(camera: str, calc_id: str, graph: dict | None = None) -> dict[str, tuple[float, float] | None]:
    """(dx, dy) of B from A in pixels by frame hash (None when a point is missing); picture axes, y points down."""
    graph = graph or load_graph(camera)
    return {k: (None if p is None else (p[1][0] - p[0][0], p[1][1] - p[0][1])) for k, p in _calc_pairs(camera, calc_id, graph).items()}


# --- evaluation --------------------------------------------------------------------
def deviation(value: float, nominal: float, wrap: bool) -> float:
    """Signed distance from nominal; an angle wraps around (359 and 1 degrees are 2 degrees apart)."""
    d = value - nominal
    if wrap:
        d = (d + 180.0) % 360.0 - 180.0
    return d


def evaluation_source(graph: dict, eval_id: str) -> str | None:
    parent = parent_of_any(graph, eval_id)
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


def zone_distance(offset: tuple[float, float] | None, zone: dict) -> float | None:
    """How far an offset lies from the zone's centre (pixels); None when there is no offset or no centre yet."""
    if offset is None or zone["center"] is None:
        return None
    return math.hypot(offset[0] - zone["center"][0], offset[1] - zone["center"][1])


def judge_zone(offset: tuple[float, float] | None, zone: dict) -> str:
    """Inside the zone (edge included) is pass, outside fail; no offset or no centre is undetermined."""
    if offset is None or zone["center"] is None:
        return "undetermined"
    dx, dy = offset[0] - zone["center"][0], offset[1] - zone["center"][1]
    if zone["shape"] == "circle":
        inside = math.hypot(dx, dy) <= zone["radius"] + 1e-9
    else:
        inside = abs(dx) <= zone["half"][0] + 1e-9 and abs(dy) <= zone["half"][1] + 1e-9
    return "pass" if inside else "fail"


def _zone_state(camera: str, node: dict, calc_id: str, graph: dict) -> dict:
    """Evaluation of an Offset: each picture's (dx, dy) judged by the zone; ``values`` is the distance from its centre."""
    zone = zone_of(node)
    by_key = calc_offsets(camera, calc_id, graph)
    hmap = labels.hash_map(camera)
    values: dict[str, float | None] = {}
    points: dict[str, list[float] | None] = {}
    verdicts: dict[str, str] = {}
    for frame in _live_frames(camera):
        key = hmap.get(frame)
        if key not in by_key:
            continue
        off = by_key[key]
        points[frame] = None if off is None else [off[0], off[1]]
        values[frame] = zone_distance(off, zone)
        verdicts[frame] = judge_zone(off, zone)
    counts = {"pass": 0, "fail": 0, "undetermined": 0}
    for v in verdicts.values():
        counts[v] += 1
    return {"mode": "zone", "zone": zone, "points": points, "values": values, "verdicts": verdicts, "counts": counts,
            "histogram": None, "wrap": False, "unit": "px"}


def evaluation_state(camera: str, eval_id: str) -> dict:
    """Per-frame value and verdict of an Evaluation box, with counts and a histogram of the values. Behind an Offset
    the box judges (dx, dy) by its zone instead (``mode`` "zone", ``points``)."""
    graph = load_graph(camera)
    node = _node(graph, eval_id)
    calc_id = evaluation_source(graph, eval_id)
    empty = {"mode": "tolerance", "zone": None, "points": {}, "values": {}, "verdicts": {}, "counts": {"pass": 0, "fail": 0, "undetermined": 0}, "histogram": None, "wrap": False, "unit": ""}
    if not calc_id:
        return empty
    calc = graph["nodes"][calc_id]
    if calc["op"] == "offset":
        return _zone_state(camera, node, calc_id, graph)
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
        "mode": "tolerance",
        "zone": None,
        "points": {},
        "values": values,
        "verdicts": verdicts,
        "counts": counts,
        "histogram": histogram,
        "wrap": wrap,
        "unit": "deg" if wrap else ("px" if calc["op"] != "angle" else ""),
    }


def feature_opinions(camera: str, feature: str) -> dict:
    """What the Evaluation boxes arrowed into this feature's Classify box say, by frame name."""
    graph = load_graph(camera)
    target = f"classify:{feature}"
    boxes = []
    for e in graph["edges"]:
        if e["target"] == target and kind_of(e["source"]) == "evaluation" and e["source"] in graph["nodes"]:
            state = evaluation_state(camera, e["source"])
            node = graph["nodes"][e["source"]]
            boxes.append({"box": e["source"], "mode": state["mode"], "zone": state["zone"], "points": state["points"], "nominal": node["nominal"], "tolerance": node["tolerance"], "unit": state["unit"], "values": state["values"], "verdicts": state["verdicts"], "counts": state["counts"]})
    return {"feature": feature, "boxes": boxes}


def feature_evaluation(camera: str, feature: str) -> str | None:
    """The Evaluation box this feature's cards show (picked in the Classifier's panel), or None."""
    graph = load_graph(camera)
    target = f"classify:{feature}"
    for e in graph["edges"]:
        if e["target"] == target and kind_of(e["source"]) == "evaluation" and e["source"] in graph["nodes"]:
            return e["source"]
    return None


def set_feature_evaluation(camera: str, feature: str, box: str | None) -> None:
    """Pick the one Evaluation box a feature's cards show, or none. Stored as the arrow ``eval -> classify:<feature>``."""
    if datamodel.get_roi(camera, feature) is None:
        raise FlowError(f"Unknown ROI: {feature}")
    graph = load_graph(camera)
    target = f"classify:{feature}"
    if box is not None:
        if kind_of(box) != "evaluation" or box not in graph["nodes"]:
            raise FlowError(f"{box} is not an Evaluation box.")
    graph["edges"] = [e for e in graph["edges"] if not (e["target"] == target and kind_of(e["source"]) == "evaluation")]
    if box is not None:
        graph["edges"].append({"source": box, "target": target})
    save_graph(camera, graph)


def freeze_record(camera: str, feature: str) -> list[dict]:
    """What a freeze records about these rules (settings and counts, never pictures)."""
    return [{"box": b["box"], **({"zone": b["zone"]} if b["mode"] == "zone" else {"nominal": b["nominal"], "tolerance": b["tolerance"]}), "counts": b["counts"]} for b in feature_opinions(camera, feature)["boxes"]]


# --- the box as the UI shows it ------------------------------------------------------
def frames_without_crop(camera: str, graph: dict, node_id: str) -> list[str]:
    """Live frames a following Crop above ``node_id`` has no box on (the detector found nothing there): they cannot be
    cut, so they are the ones to look at. Empty when no Crop above follows a detector."""
    steps = [c for c in input_rects(graph, node_id) if is_follow(c)]
    if not steps:
        return []
    finder = Finder(camera)
    hmap = labels.hash_map(camera)
    missing = []
    for frame in _live_frames(camera):
        key = hmap.get(frame)
        if any(finder.box(c["follow"]["detector"], key, c["follow"]["target"]) is None for c in steps):
            missing.append(frame)
    return missing


def follow_detail(camera: str, graph: dict, crop_id: str) -> dict | None:
    """What the Crop page needs of a following Crop: the target it follows, the rectangle drawn (size, offset, the
    picture it was drawn on) and the pictures it has no box on. None when the Crop is not fed by a detector target."""
    follow = follow_of(graph, crop_id)
    if not follow:
        return None
    spec = graph["nodes"][crop_id].get("follow") or {}
    mode = crop_mode(graph, crop_id)
    target = next((t for t in graph["nodes"].get(follow["detector"], {}).get("targets", []) if t["name"] == follow["target"]), {})
    offered = outputs_of(target)
    return {
        **follow,
        "mode": mode,
        "offered": offered,
        "modes": [{"id": k, "label": m["label"], "enabled": all(o in offered for o in m["needs"]),
                   "needs": [OUTPUTS[o] for o in m["needs"] if o not in offered]} for k, m in FOLLOW_MODES.items()],
        "frame": spec.get("frame"),
        "size": spec.get("size"),
        "offset": spec.get("offset"),
        "missing": _missing_for_follow(camera, follow),
    }


def _missing_for_follow(camera: str, follow: dict) -> list[str]:
    finder = Finder(camera)
    hmap = labels.hash_map(camera)
    return [f for f in _live_frames(camera) if finder.box(follow["detector"], hmap.get(f), follow["target"]) is None]


def node_detail(camera: str, node_id: str, graph: dict | None = None) -> dict:
    graph = graph or load_graph(camera)
    node = _node(graph, node_id)
    kind = node["kind"]
    detail: dict = {"kind": kind}
    if kind == "crop":
        parent = parent_of(graph, node_id)
        detail.update({
            "steps": crop_steps(node), "follow_step": follow_step_id(graph, node_id), "input_box": parent,
            "crops": input_rects(graph, node_id), "follow": follow_detail(camera, graph, node_id),
        })
    elif kind == "detector":
        parent = parent_of(graph, node_id)
        detail.update({
            "input": parent if parent and kind_of(parent) == "detector" else INGEST_ID,
            "input_box": parent,
            "parent_targets": parent_target_names(graph, node_id),
            "crops": input_rects(graph, node_id),
            "no_crop": frames_without_crop(camera, graph, node_id),
            "targets": [
                {"name": t["name"], "inside": t.get("inside"), "outputs": outputs_of(t), "examples": [{"frame": e["frame"], "box": e["box"], "png": "data:image/png;base64," + e["png"], "scale": e.get("scale", 1.0), "angle": e.get("angle", 0.0)} for e in t["examples"]]}
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
        parent = calc_detector(graph, node_id)
        detail.update({
            "op": node["op"], "operations": OPERATIONS, "points": names, "a": a, "b": b, "clockwise": node["clockwise"],
            "measured": len(values),
            "input": parent,  # the one detector both points come from (None when they come from two), and the crops above it
            "crops": input_rects(graph, parent) if parent else [],
        })
    elif kind == "dedup":
        parent = next((e["source"] for e in graph["edges"] if e["target"] == node_id), None)
        detail.update({"input_box": parent, "source": node.get("source")})
    elif kind == "evaluation":
        calc_id = evaluation_source(graph, node_id)
        state = evaluation_state(camera, node_id)
        detail.update({
            "nominal": node["nominal"], "tolerance": node["tolerance"], "calc": calc_id,
            "mode": state["mode"], "zone": state["zone"] or zone_of(node),
            "wrap": state["wrap"], "unit": state["unit"], "counts": state["counts"], "histogram": state["histogram"],
            "features": [e["target"].split(":", 1)[1] for e in graph["edges"] if e["source"] == node_id],
        })
    return detail
