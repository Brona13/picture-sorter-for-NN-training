"""Detector-anchored ROI: a ROI whose rectangle follows a box a detector found, per picture.

The rectangle is drawn by hand on one exemplar picture (the static ROI row). ``set_anchor`` remembers where that
rectangle lies relative to the detector's box on that picture (centre offset and size, in pixels, plus the
detected angle). On any other picture ``rect_for`` puts the rectangle at the same place relative to the box the
detector found there; with ``follow_rotation`` the offset turns with the detected angle (the crop stays an
axis-aligned rectangle: the bounding box of the turned one). A picture without a box has no rectangle (``None``);
there is no fallback to the static rectangle, which would mix wrong crops into labels and scores.

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
from roi import ROI

KEY_PREFIX = "roi.anchor."


class AnchorError(ValueError):
    """The anchor cannot be set or is not valid."""


def _key(feature: str) -> str:
    return f"{KEY_PREFIX}{feature}"


def get_anchor(camera: str, feature: str, con=None) -> dict | None:
    """The stored anchor of a ROI, or ``None``. Reads through ``con`` when the caller already holds a connection."""
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
    return data if isinstance(data, dict) and data.get("detector") and data.get("target") else None


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
    return flow.load_stored(camera, detector)["frames"].get(frame_hash, {}).get(target)


def entry_for(camera: str, spec: dict, frame_hash: str) -> dict | None:
    """The box the anchoring detector found on this picture, or ``None``."""
    return _entry(camera, spec["detector"], spec["target"], frame_hash)


def frame_key(spec: dict, entry: dict) -> str:
    """What about the detected box changes the rectangle on this picture (goes behind the frame hash in cache keys)."""
    angle = f",{float(entry['angle']):.2f}" if spec.get("follow_rotation") else ""
    return f"a={float(entry['x']):.2f},{float(entry['y']):.2f}{angle}"


def set_anchor(camera: str, feature: str, detector: str, target: str, frame: str, *, follow_rotation: bool = False,
               image_size: tuple[int, int] | None = None) -> dict:
    """Anchor ``feature`` to ``target`` of ``detector`` using the static rectangle as it lies on ``frame``.
    ``image_size`` is (width, height) of that picture; read from the file when not given."""
    roi = datamodel.get_roi(camera, feature)
    if roi is None:
        raise AnchorError(f"Unknown ROI: {feature}")
    graph = flow.load_graph(camera)
    node = graph["nodes"].get(detector)
    if node is None or node["kind"] != "detector":
        raise AnchorError("The anchor must be a detector box.")
    if target not in [t["name"] for t in node["targets"]]:
        raise AnchorError(f"The detector has no target named {target!r}.")
    key = labels.hash_map(camera).get(frame)
    entry = key and _entry(camera, detector, target, key)
    if not entry:
        raise AnchorError(f"The detector has not found {target!r} on {frame}; pick a picture where it did.")
    if image_size is None:
        import curation  # noqa: PLC0415

        picture = curation.load_image(datamodel.unsorted_dir(camera) / frame)
        image_size = (picture.shape[1], picture.shape[0])
    width, height = image_size
    anchor = {
        "detector": detector,
        "target": target,
        "follow_rotation": bool(follow_rotation),
        "angle0": float(entry["angle"]),
        "dx": round((roi.x + roi.w / 2) * width - float(entry["x"]), 2),
        "dy": round((roi.y + roi.h / 2) * height - float(entry["y"]), 2),
        "w": round(roi.w * width, 2),
        "h": round(roi.h * height, 2),
    }
    db.set_setting(camera, _key(feature), json.dumps(anchor, sort_keys=True))
    return anchor


def rect_for(anchor: dict, entry: dict | None, name: str, img_w: int, img_h: int) -> ROI | None:
    """The anchored rectangle on a picture of ``img_w`` x ``img_h`` where the detector found ``entry``; ``None`` when
    there is no box or the rectangle lies completely outside the picture."""
    if not entry:
        return None
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
    goes into the frame key)."""
    graph = flow.load_graph(camera)
    sig = flow.signature(graph, anchor["detector"]) if anchor["detector"] in graph["nodes"] else "gone"
    return "anchor:{detector}:{target}:{r}:{dx},{dy},{w},{h}:{sig}".format(r=int(bool(anchor.get("follow_rotation"))), sig=sig, **{k: anchor[k] for k in ("detector", "target", "dx", "dy", "w", "h")})
