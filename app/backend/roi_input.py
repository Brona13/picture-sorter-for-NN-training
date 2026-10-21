"""A ROI that reads its picture from a Picture edits box (``crop:N``) instead of the plain frame.

The ROI is cut from the box's output: the frame after the box's filter steps, in the same place (a box that moves
the geometry - a drawn crop or a straightening - is refused, because the ROI's rectangle is stored as fractions of the
whole picture). Scores, thumbnails and detectors that read the ROI see the filtered pixels.

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
    """The stored input of a ROI (``{"box": id}``), or ``None``. Reads through ``con`` when the caller holds one."""
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
    if flow.follow_of(graph, box) is not None:
        return "it follows a detector target; the ROI would need a picture without a moving crop."
    for step in flow.output_rects(graph, box):
        if not flow.is_filter(step):
            return "it crops the picture. Only filter steps can feed a ROI for now (clear the crop or remove the step)."
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
    spec = {"box": box}
    db.set_setting(camera, _key(feature), json.dumps(spec))
    return spec


def steps(camera: str, feature: str, graph: dict | None = None) -> list[dict]:
    """The filter steps (``{"filter": ...}``) a ROI's picture goes through first; empty when it reads the plain frame."""
    spec = get_input(camera, feature)
    if not spec:
        return []
    graph = graph or flow.load_graph(camera)
    if problem(graph, spec["box"]):
        return []  # the box changed under it; the guards in flow keep this from happening
    return [s for s in flow.output_rects(graph, spec["box"]) if flow.is_filter(s)]


def apply(camera: str, feature: str, image):
    """``image`` after the ROI's input box (unchanged when it has none)."""
    for step in steps(camera, feature):
        image = flow.preprocess.apply(image, step["filter"]["name"], step["filter"]["params"])
    return image


def rule_key(camera: str, feature: str, con=None) -> str:
    """Part of the ROI's cache key: changes when the box's filters change. Empty without an input."""
    spec = get_input(camera, feature, con)
    if not spec:
        return ""
    material = json.dumps(steps(camera, feature), sort_keys=True)
    return "pe=" + hashlib.sha1(material.encode()).hexdigest()[:12]


def tuple_part(camera: str, feature: str) -> str:
    """The sixth element of a thumbnail's ROI tuple: the filter steps as JSON ('' for none)."""
    s = steps(camera, feature)
    return json.dumps(s, sort_keys=True) if s else ""


def apply_json(image, steps_json: str):
    for step in json.loads(steps_json) if steps_json else []:
        image = flow.preprocess.apply(image, step["filter"]["name"], step["filter"]["params"])
    return image
