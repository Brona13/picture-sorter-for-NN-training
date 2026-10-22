"""A ROI that reads its picture from a Picture edits box (``crop:N``) instead of the plain frame.

The ROI is cut from the box's output: the picture after all the box's steps (crops, a followed detector target,
filters). The ROI's rectangle is then a fraction of that edited picture, not of the whole frame. A picture on which a
following crop has no box (the detector found nothing there) has no ROI picture: no vectors, scores or thumbnail, like
a detector-anchored ROI. Scores, thumbnails and detectors that read the ROI see the edited pixels.

Stored in the camera setting ``roi.input.<feature>`` as ``{"box": "crop:N"}``; the ``rois`` table is unchanged.
A ROI is either anchored to a detector or reads a Picture edits box, not both.
"""
from __future__ import annotations

import hashlib
import json

import datamodel
import db
import flow

KEY_PREFIX = "roi.input."


class RoiInputError(ValueError):
    """The ROI cannot read that box."""


def _key(feature: str) -> str:
    return f"{KEY_PREFIX}{feature}"


def get_input(camera: str, feature: str, con=None) -> dict | None:
    """The stored input of a ROI (``{"box": id}``), or ``None``. Reads through ``con`` when the caller holds one.

    A Dedup box (``dedup:N``) has no setting of its own: the Picture edits box a line comes from is its input."""
    if flow.kind_of(feature) == "dedup":
        graph = flow.load_graph(camera)
        parent = flow.parent_of(graph, feature) if feature in graph["nodes"] else None
        return {"box": parent} if parent and flow.kind_of(parent) == "crop" else None
    if con is None:
        raw = db.get_setting(camera, _key(feature))
    else:
        row = con.execute("SELECT value FROM settings WHERE camera=? AND key=?", (camera, _key(feature))).fetchone()
        raw = row["value"] if row else None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("box"), str) else None


def clear_input(camera: str, feature: str) -> None:
    con = db.connect()
    try:
        con.execute("DELETE FROM settings WHERE camera=? AND key=?", (camera, _key(feature)))
        con.commit()
    finally:
        con.close()


def all_inputs(camera: str) -> dict[str, str]:
    """feature -> box id for every ROI of the camera that reads a box."""
    out = {}
    for roi in datamodel.load_rois(camera):
        spec = get_input(camera, roi.name)
        if spec:
            out[roi.name] = spec["box"]
    return out


def drop_for_box(camera: str, box: str) -> list[str]:
    """Forget the inputs on a box that was deleted; returns the ROIs that read the whole picture again."""
    freed = []
    for feature, b in all_inputs(camera).items():
        if b == box:
            clear_input(camera, feature)
            freed.append(feature)
    return freed


def problem(graph: dict, box: str) -> str | None:
    """Why a ROI cannot read ``box`` in ``graph`` (``None`` when it can)."""
    if box not in graph["nodes"] or flow.kind_of(box) != "crop":
        return "that is not a Picture edits box."
    return None


def set_input(camera: str, feature: str, box: str) -> dict:
    roi = datamodel.get_roi(camera, feature)
    if roi is None:
        raise RoiInputError(f"Unknown ROI: {feature}")
    if roi.role == "classify":
        raise RoiInputError("The product-sorting ROI always reads the whole picture.")
    import anchor  # noqa: PLC0415

    if anchor.get_anchor(camera, feature):
        raise RoiInputError(f"{feature} is anchored to a detector; remove that arrow first.")
    why = problem(flow.load_graph(camera), box)
    if why:
        raise RoiInputError(f"{feature} cannot read {box}: {why}")
    if not get_input(camera, feature):  # its rectangle was drawn on the whole frame: start from the whole edited picture
        rois = datamodel.load_rois(camera)
        for r in rois:
            if r.name == feature:
                r.x, r.y, r.w, r.h = 0.0, 0.0, 1.0, 1.0
        datamodel.save_rois(camera, rois)
    spec = {"box": box}
    db.set_setting(camera, _key(feature), json.dumps(spec))
    return spec


def _rects(camera: str, feature: str, graph: dict | None = None) -> list | None:
    spec = get_input(camera, feature)
    if not spec:
        return None
    graph = graph or flow.load_graph(camera)
    if problem(graph, spec["box"]):
        return None  # the box is gone (deleting it frees the ROI, so this is only a stale read)
    return flow.output_rects(graph, spec["box"])


def edited(camera: str, feature: str, image, frame: str):
    """``image`` (the whole frame ``frame``) after the ROI's input box; unchanged when it has none. Raises
    ``FileNotFoundError`` when a following crop has no box on this picture (callers treat that as "no picture")."""
    rects = _rects(camera, feature)
    if rects is None:
        return image
    try:
        return flow.apply_rects(image, rects, flow._found_for(camera, rects, frame))[0]
    except flow.NoCrop as exc:
        raise FileNotFoundError(str(exc)) from exc


def rule_key(camera: str, feature: str, con=None) -> str:
    """Part of the ROI's cache key: changes when the box's steps (or a followed detector) change. Empty without an input."""
    spec = get_input(camera, feature, con)
    if not spec:
        return ""
    graph = flow.load_graph(camera)
    rects = _rects(camera, feature, graph) or []
    material = [
        {**r, "sig": flow.signature(graph, r["follow"]["detector"])} if flow.is_follow(r) and r["follow"]["detector"] in graph["nodes"] else r
        for r in rects
    ]
    return "pe=" + hashlib.sha1(json.dumps(material, sort_keys=True, default=str).encode()).hexdigest()[:12]


def tuple_part(camera: str, feature: str) -> str:
    """The sixth element of a thumbnail's ROI tuple (empty without an input): camera, feature and the rule key."""
    key = rule_key(camera, feature)
    return f"{camera}\t{feature}\t{key}" if key else ""


def edited_for_tuple(part: str, image, frame: str):
    camera, feature, _ = part.split("\t")
    return edited(camera, feature, image, frame)
