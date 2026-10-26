"""Detector-anchored ROI: a ROI whose rectangle follows a box a detector found, per picture.

Two modes (``spec["mode"]``):

* ``box`` - the ROI *is* the found box: the axis-aligned box around the found (possibly turned) example, grown by
  ``margin`` (a fraction of its size) on every side. Nothing is drawn.
* ``rect`` - the user draws the rectangle (the static ROI row) on an exemplar picture (``spec["frame"]``). Where it
  lies relative to the detector's box there (centre offset and size in pixels, plus the detected angle) is read from
  the ROI's *current* rectangle (``effective``), so redrawing it needs no new anchor; the offsets stored with the
  anchor are only a snapshot for when the exemplar's box is gone. On any other picture ``rect_for`` puts the
  rectangle at the same place relative to the box found there; with ``follow_rotation`` the offset turns with the
  detected angle (the crop stays an axis-aligned rectangle: the bounding box of the turned one).

A picture without a box has no rectangle (``None``); there is no fallback to the static rectangle, which would mix
wrong crops into labels and scores. An anchor stored before the modes existed (v1.67.0) has no ``mode`` and reads as
``rect`` with its stored offsets.

Stored in the camera setting ``roi.anchor.<feature>``; the ``rois`` table and ``ROI`` are unchanged.
Angles are degrees, counter-clockwise as seen on screen (the detector's convention), the picture's y axis down.
"""
from __future__ import annotations

import json
import math

import datamodel
import db
import flow
import labels
import rotsearch
from roi import ROI

KEY_PREFIX = "roi.anchor."
DEFAULT_MARGIN = 0.1
MODES = ("box", "rect")


class AnchorError(ValueError):
    """The anchor cannot be set or is not valid."""


def _key(feature: str) -> str:
    return f"{KEY_PREFIX}{feature}"


def get_anchor(camera: str, feature: str, con=None) -> dict | None:
    """The stored anchor of a ROI, or ``None``. Reads through ``con`` when the caller already holds a connection.

    A Dedup box fed by a detector target (v1.99.0) has no setting of its own: the line is its anchor, in mode ``box``,
    so its embeddings are made from the box the detector found."""
    if flow.kind_of(feature) == "dedup":
        graph = flow.load_graph(camera)
        line = next((e for e in graph["edges"] if e["target"] == feature and e.get("point") and flow.kind_of(e["source"]) == "detector"), None)
        if line is None:
            return None
        return {"detector": line["source"], "target": line["point"], "mode": "box", "margin": DEFAULT_MARGIN}
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
    if not (isinstance(data, dict) and data.get("detector") and data.get("target")):
        return None
    data.setdefault("mode", "rect")
    data.setdefault("margin", DEFAULT_MARGIN)
    return data


def clear_anchor(camera: str, feature: str) -> None:
    con = db.connect()
    try:
        con.execute("DELETE FROM settings WHERE camera=? AND key=?", (camera, _key(feature)))
        con.commit()
    finally:
        con.close()


def drop_for_detector(camera: str, detector: str, target: str | None = None) -> list[str]:
    """Forget the anchors on a detector (or on one of its targets) that was deleted; returns the ROIs made static."""
    freed = []
    for roi in datamodel.load_rois(camera):
        spec = get_anchor(camera, roi.name)
        if spec and spec["detector"] == detector and target in (None, spec["target"]):
            clear_anchor(camera, roi.name)
            freed.append(roi.name)
    return freed


def _entry(camera: str, detector: str, target: str, frame_hash: str) -> dict | None:
    """The box the detector stored for this picture, with the crops above the detector (``rects``) it was found in."""
    entry = flow.load_stored(camera, detector)["frames"].get(frame_hash, {}).get(target)
    if not entry:
        return None
    graph = flow.load_graph(camera)
    rects = flow.input_rects(graph, detector) if detector in graph["nodes"] else []
    return {**entry, "rects": rects, **_finder(camera, rects, frame_hash)}


PIXEL_CENTRE = 0.5  # a detector reports the index of the centre pixel; a pixel i covers [i, i + 1] when rectangles are cut


def _finder(camera: str, rects: list, frame_hash: str, finder: "flow.Finder | None" = None) -> dict:
    """``{"found": ...}`` for an entry whose detector sits behind a Crop that follows a detector (else nothing)."""
    if not flow.has_follow(rects):
        return {}
    return {"found": (finder or flow.Finder(camera)).for_frame(frame_hash)}


def _on_frame(entry: dict, img_w: int, img_h: int) -> dict | None:
    """The box in the coordinates of the whole picture (a detector behind a Crop box finds it in the cropped picture),
    as a position in pixel-edge coordinates (the half pixel from pixel indices to pixel edges is added). ``None`` when
    a Crop that follows a detector has no rectangle on this picture."""
    try:
        where = flow.rect_map(entry.get("rects") or [], img_w, img_h, entry.get("found"))
    except flow.NoCrop:
        return None
    x, y = where.point(entry["x"], entry["y"])
    return {**entry, "x": x + PIXEL_CENTRE, "y": y + PIXEL_CENTRE, "angle": float(entry.get("angle", 0.0)) + where.turn}


class Source:
    """The anchoring detector's stored boxes, loaded once (scoring asks for every picture of the camera)."""

    def __init__(self, camera: str, spec: dict) -> None:
        self.target = spec["target"]
        graph = flow.load_graph(camera)
        self.camera = camera
        self.rects = flow.input_rects(graph, spec["detector"]) if spec["detector"] in graph["nodes"] else []
        self.frames = flow.load_stored(camera, spec["detector"])["frames"]
        self.finder = flow.Finder(camera)

    def entry(self, frame_hash: str) -> dict | None:
        found = self.frames.get(frame_hash, {}).get(self.target)
        return {**found, "rects": self.rects, **_finder(self.camera, self.rects, frame_hash, self.finder)} if found else None


def entry_for(camera: str, spec: dict, frame_hash: str, source: "Source | None" = None) -> dict | None:
    """The box the anchoring detector found on this picture, or ``None``."""
    if source is not None:
        return source.entry(frame_hash)
    return _entry(camera, spec["detector"], spec["target"], frame_hash)


def _image_size(camera: str, frame: str) -> tuple[int, int]:
    from PIL import Image  # noqa: PLC0415

    with Image.open(datamodel.unsorted_dir(camera) / frame) as picture:
        return picture.size


def effective(camera: str, feature: str, spec: dict, source: "Source | None" = None) -> dict:
    """``spec`` with the offsets of mode ``rect`` read from the ROI's current rectangle on the exemplar picture.
    Falls back to the stored snapshot when the exemplar, its box or the ROI is gone."""
    if spec.get("mode") != "rect" or not spec.get("frame"):
        return spec
    roi = datamodel.get_roi(camera, feature)
    key = labels.hash_map(camera).get(spec["frame"])
    entry = key and (source.entry(key) if source else _entry(camera, spec["detector"], spec["target"], key))
    if roi is None or not entry:
        return spec
    try:
        width, height = _image_size(camera, spec["frame"])
    except OSError:
        return spec
    entry = _on_frame(entry, width, height)
    if entry is None:
        return spec
    return {
        **spec,
        "angle0": float(entry["angle"]),
        "dx": round((roi.x + roi.w / 2) * width - float(entry["x"]), 2),
        "dy": round((roi.y + roi.h / 2) * height - float(entry["y"]), 2),
        "w": round(roi.w * width, 2),
        "h": round(roi.h * height, 2),
    }


def found_box(camera: str, spec: dict, frame: str) -> dict | None:
    """The detector's box on ``frame`` as a rectangle in fractions of that picture (for the ROI editor), or ``None``."""
    key = labels.hash_map(camera).get(frame)
    entry = key and _entry(camera, spec["detector"], spec["target"], key)
    if not entry:
        return None
    width, height = _image_size(camera, frame)
    entry = _on_frame(entry, width, height)
    if entry is None:
        return None
    x0, y0, x1, y1 = rotsearch.Match(entry["x"], entry["y"], entry["angle"], entry.get("score", 1.0), entry["w"], entry["h"]).bbox()
    x0, y0, x1, y1 = max(0.0, x0), max(0.0, y0), min(float(width), x1), min(float(height), y1)
    return {"x": x0 / width, "y": y0 / height, "w": (x1 - x0) / width, "h": (y1 - y0) / height}


def frame_key(spec: dict, entry: dict) -> str:
    """What about the detected box changes the rectangle on this picture (goes behind the frame hash in cache keys)."""
    angle = f",{float(entry['angle']):.2f}" if spec.get("follow_rotation") else ""
    return f"a={float(entry['x']):.2f},{float(entry['y']):.2f}{angle}"


def set_anchor(camera: str, feature: str, detector: str, target: str, frame: str | None = None, *, mode: str = "box",
               margin: float = DEFAULT_MARGIN, follow_rotation: bool = False,
               image_size: tuple[int, int] | None = None) -> dict:
    """Anchor ``feature`` to ``target`` of ``detector``. Mode ``box`` needs nothing more; mode ``rect`` needs ``frame``,
    the exemplar picture the ROI's rectangle is drawn on (the detector must have found the target there).
    ``image_size`` is (width, height) of that picture; read from the file when not given."""
    roi = datamodel.get_roi(camera, feature)
    if roi is None:
        raise AnchorError(f"Unknown ROI: {feature}")
    import roi_input  # noqa: PLC0415

    if roi_input.get_input(camera, feature):
        raise AnchorError(f"{feature} reads a Picture edits box; remove that arrow first.")
    if mode not in MODES:
        raise AnchorError("The mode is box or rect.")
    if not 0.0 <= margin <= 1.0:
        raise AnchorError("The margin is a fraction between 0 and 1.")
    graph = flow.load_graph(camera)
    node = graph["nodes"].get(detector)
    if node is None or node["kind"] != "detector":
        raise AnchorError("The anchor must be a detector box.")
    if target not in flow.all_slots(node):
        raise AnchorError(f"The detector has no target named {target!r}.")
    anchor = {"detector": detector, "target": target, "mode": mode, "margin": round(float(margin), 4),
              "follow_rotation": bool(follow_rotation)}
    if mode == "rect":
        if not frame:
            raise AnchorError("Pick the picture the rectangle is drawn on.")
        key = labels.hash_map(camera).get(frame)
        if not (key and _entry(camera, detector, target, key)):
            raise AnchorError(f"The detector has not found {target!r} on {frame}; pick a picture where it did.")
        if image_size is not None:  # known size (no file read): compute the snapshot here
            width, height = image_size
            entry = _on_frame(_entry(camera, detector, target, key), width, height)
            if entry is None:
                raise AnchorError(f"The Crop before {detector} has no rectangle on {frame}; pick another picture.")
            anchor.update({
                "angle0": float(entry["angle"]),
                "dx": round((roi.x + roi.w / 2) * width - float(entry["x"]), 2),
                "dy": round((roi.y + roi.h / 2) * height - float(entry["y"]), 2),
                "w": round(roi.w * width, 2),
                "h": round(roi.h * height, 2),
            })
        else:
            anchor.update({k: v for k, v in effective(camera, feature, {**anchor, "frame": frame}).items() if k in ("angle0", "dx", "dy", "w", "h")})
        anchor["frame"] = frame
    db.set_setting(camera, _key(feature), json.dumps(anchor, sort_keys=True))
    return get_anchor(camera, feature) or anchor


def rect_for(anchor: dict, entry: dict | None, name: str, img_w: int, img_h: int) -> ROI | None:
    """The anchored rectangle on a picture of ``img_w`` x ``img_h`` where the detector found ``entry``; ``None`` when
    there is no box or the rectangle lies completely outside the picture."""
    if not entry:
        return None
    entry = _on_frame(entry, img_w, img_h)
    if entry is None:
        return None
    if anchor.get("mode") == "box":
        x0, y0, x1, y1 = rotsearch.Match(entry["x"], entry["y"], entry["angle"], entry.get("score", 1.0), entry["w"], entry["h"]).bbox()
        gx, gy = (x1 - x0) * float(anchor.get("margin", DEFAULT_MARGIN)), (y1 - y0) * float(anchor.get("margin", DEFAULT_MARGIN))
        x0, y0, x1, y1 = max(0.0, x0 - gx), max(0.0, y0 - gy), min(float(img_w), x1 + gx), min(float(img_h), y1 + gy)
        if x1 - x0 < 1 or y1 - y0 < 1:
            return None
        return ROI(name=name, x=x0 / img_w, y=y0 / img_h, w=(x1 - x0) / img_w, h=(y1 - y0) / img_h)
    dx, dy, w, h = anchor["dx"], anchor["dy"], anchor["w"], anchor["h"]
    if anchor.get("follow_rotation"):
        delta = math.radians(float(entry["angle"]) - float(anchor.get("angle0", 0.0)))
        c, s = math.cos(delta), math.sin(delta)
        dx, dy = dx * c + dy * s, -dx * s + dy * c
        w, h = abs(w * c) + abs(h * s), abs(w * s) + abs(h * c)
    cx, cy = float(entry["x"]) + dx, float(entry["y"]) + dy
    x0, y0 = max(0.0, cx - w / 2), max(0.0, cy - h / 2)
    x1, y1 = min(float(img_w), cx + w / 2), min(float(img_h), cy + h / 2)
    if x1 - x0 < 1 or y1 - y0 < 1:
        return None
    return ROI(name=name, x=x0 / img_w, y=y0 / img_h, w=(x1 - x0) / img_w, h=(y1 - y0) / img_h)


def rule_key(anchor: dict, camera: str) -> str:
    """Identifies the rule and the detector run it follows; goes into the ROI cache key (the per-frame rectangle
    goes into the frame key). In mode ``rect`` the ROI's own rectangle (already in the key) carries the offsets."""
    graph = flow.load_graph(camera)
    sig = flow.signature(graph, anchor["detector"]) if anchor["detector"] in graph["nodes"] else "gone"
    shape = f"box:{anchor.get('margin', DEFAULT_MARGIN)}" if anchor.get("mode") == "box" else f"rect:{anchor.get('frame', '')}"
    return f"anchor:{anchor['detector']}:{anchor['target']}:{int(bool(anchor.get('follow_rotation')))}:{shape}:{sig}"
