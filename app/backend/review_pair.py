"""The pair map of a detector page (v1.170.0): how two targets of one detector sit relative to each other on every
picture, measured and judged exactly as a Calculate box and an Evaluation would (``flow.compute``, ``flow.judge``,
``flow.judge_zone``, positions on the whole picture), but without those boxes in the Chain.

A review aid like the position map's zones: it is saved on the detector box as ``review_pair``, is not part of
``flow.signature`` (changing it never makes the run stale), and nothing downstream reads it. The pictures it judges
"fail" join the detector page's *Outside* filter.
"""
from __future__ import annotations

import math

import flow
import labels


def _slots(node: dict) -> set[str]:
    return {s for t in node.get("targets", []) for s in flow.slot_names(t)}


def settings(node: dict) -> dict | None:
    """The saved pair with every field filled in, or None when there is none (or a target it names is gone)."""
    raw = node.get("review_pair")
    if not isinstance(raw, dict) or raw.get("a") not in _slots(node) or raw.get("b") not in _slots(node):
        return None
    return {
        "a": raw["a"],
        "b": raw["b"],
        "op": raw.get("op") if raw.get("op") in flow.OPERATIONS else "distance",
        "clockwise": bool(raw.get("clockwise", False)),
        "nominal": raw.get("nominal"),
        "tolerance": float(raw.get("tolerance", 3.0)),
        "zone": flow.clean_zone(None, raw.get("zone")),
    }


def apply(node: dict, raw: object) -> None:
    """Change some fields of the pair (``a``, ``b``, ``op``, ``clockwise``, ``nominal``, ``tolerance``, ``zone``), or remove
    it with None. A new operation clears the nominal and the zone: a distance is not an angle."""
    if raw is None:
        node.pop("review_pair", None)
        return
    if not isinstance(raw, dict):
        raise flow.FlowError("The pair is an object.")
    pair = dict(node.get("review_pair") or {})
    slots = _slots(node)
    for key in ("a", "b"):
        if key in raw:
            if raw[key] not in slots:
                raise flow.FlowError(f"Unknown target: {raw[key]}")
            pair[key] = raw[key]
    if pair.get("a") is None or pair.get("b") is None:
        raise flow.FlowError("A pair needs two targets, A and B.")
    if pair["a"] == pair["b"]:
        raise flow.FlowError("A and B must be two different targets.")
    if "op" in raw:
        if raw["op"] not in flow.OPERATIONS:
            raise flow.FlowError(f"Unknown operation: {raw['op']}")
        if raw["op"] != pair.get("op"):
            pair["nominal"] = None
            pair.pop("zone", None)
        pair["op"] = raw["op"]
    if "clockwise" in raw:
        pair["clockwise"] = bool(raw["clockwise"])
    if "nominal" in raw:
        pair["nominal"] = None if raw["nominal"] is None else _finite(raw["nominal"], "Nominal")
    if "tolerance" in raw:
        tol = _finite(raw["tolerance"], "Tolerance")
        if tol < 0:
            raise flow.FlowError("The tolerance cannot be negative.")
        pair["tolerance"] = tol
    if "zone" in raw:
        pair["zone"] = flow.clean_zone(raw["zone"], pair.get("zone"))
    node["review_pair"] = pair


def _finite(value: object, what: str) -> float:
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise flow.FlowError(f"{what} must be a number.") from None
    if not math.isfinite(v):
        raise flow.FlowError(f"{what} must be a number.")
    return v


def state(camera: str, det_id: str) -> dict:
    """Per picture of the detector: the value (``values``), for an Offset the (dx, dy) (``points``), and the verdict, with
    counts and the histogram, in the shape of an Evaluation's state. Empty when no pair is set."""
    graph = flow.load_graph(camera)
    node = graph["nodes"].get(det_id)
    if node is None or flow.kind_of(det_id) != "detector":
        raise flow.FlowError(f"Unknown detector: {det_id}")
    pair = settings(node)
    out = {"pair": pair, "operations": flow.OPERATIONS, "mode": "tolerance", "values": {}, "points": {}, "verdicts": {},
           "counts": {"pass": 0, "fail": 0, "undetermined": 0}, "histogram": None, "wrap": False, "unit": ""}
    if pair is None:
        return out
    zone_mode = pair["op"] == "offset"
    wrap = pair["op"] == "angle"
    boxes = flow.whole_picture_boxes(camera, graph, {"a": (det_id, pair["a"]), "b": (det_id, pair["b"])})
    hmap = labels.hash_map(camera)
    stored = flow.load_stored(camera, det_id)["frames"]
    for frame in flow.node_frames(camera, det_id, graph):
        if hmap.get(frame) not in stored:
            continue  # not run on this picture yet
        here = boxes.get(frame, {})
        a, b = here.get("a"), here.get("b")
        if a is None or b is None:
            value, point = None, None
        else:
            pa, pb = (a["x"], a["y"]), (b["x"], b["y"])
            value = flow.compute(pair["op"], pa, pb, pair["clockwise"])
            point = [pb[0] - pa[0], pb[1] - pa[1]]
        out["values"][frame] = value
        if zone_mode:
            out["points"][frame] = point
            out["verdicts"][frame] = flow.judge_zone(None if point is None else (point[0], point[1]), pair["zone"])
        else:
            out["verdicts"][frame] = flow.judge(value, pair, wrap)
    for v in out["verdicts"].values():
        out["counts"][v] += 1
    if not zone_mode:
        out["histogram"] = flow.value_histogram([v for v in out["values"].values() if v is not None], wrap)
    out.update(mode="zone" if zone_mode else "tolerance", wrap=wrap, unit="deg" if wrap else "px")
    return out
