"""Stored object detections and the mask offsets derived from them.

One row per (camera, feature, frame hash, rank); rank 0 is the box used to anchor the
mask. ``status``: ``auto`` (written by the detector, replaced by re-detection), or
``reviewed``/``manual`` (a human decision, never overwritten by re-detection).
Boxes are normalised to the feature's ROI crop.
"""
from __future__ import annotations

import time

import db
import vision_settings

AUTO, REVIEWED, MANUAL = "auto", "reviewed", "manual"
HUMAN = (REVIEWED, MANUAL)


def load(camera: str, feature: str, con=None) -> dict[str, list[dict]]:
    """hash -> detections sorted by rank."""
    own = con is None
    con = con or db.connect()
    try:
        rows = con.execute(
            "SELECT hash, rank, x, y, w, h, conf, status, sig FROM detections "
            "WHERE camera=? AND feature=? ORDER BY hash, rank",
            (camera, feature),
        ).fetchall()
    finally:
        if own:
            con.close()
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r["hash"], []).append({k: r[k] for k in r.keys() if k != "hash"})
    return out


def trusted_box(rows: list[dict] | None, sig: str, threshold: float) -> dict | None:
    """Rank-0 box if it may anchor the mask: human-set, or a current confident auto box."""
    if not rows:
        return None
    top = rows[0]
    ok = top["status"] in HUMAN or (top["sig"] == sig and top["conf"] >= threshold)
    return {k: top[k] for k in ("x", "y", "w", "h")} if ok else None


def offsets(camera: str, feature: str, settings: dict, con=None) -> dict[str, tuple[float, float]]:
    """hash -> (dx, dy) shifting the mask onto each frame's trusted detection.

    Empty unless the mask is anchored (enabled, with exemplars). Frames without a trusted
    detection are absent, so their mask stays where it was drawn.
    """
    if not vision_settings.anchored(settings):
        return {}
    ref_x, ref_y = vision_settings.reference_center(settings)
    sig = vision_settings.detection_signature(settings)
    threshold = settings["detector"]["threshold"]
    out: dict[str, tuple[float, float]] = {}
    for h, rows in load(camera, feature, con).items():
        box = trusted_box(rows, sig, threshold)
        if box:
            out[h] = (
                round(box["x"] + box["w"] / 2 - ref_x, 4),
                round(box["y"] + box["h"] / 2 - ref_y, 4),
            )
    return out


def save_auto(camera: str, feature: str, frame_hash: str, found: list[tuple[dict, float]], sig: str) -> bool:
    """Replace a frame's auto detections with ``found`` [(box, confidence)], best first.

    Returns False (and writes nothing) when a human already decided this frame.
    """
    con = db.connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        existing = con.execute(
            "SELECT status FROM detections WHERE camera=? AND feature=? AND hash=? AND rank=0",
            (camera, feature, frame_hash),
        ).fetchone()
        if existing and existing["status"] in HUMAN:
            con.execute("ROLLBACK")
            return False
        con.execute(
            "DELETE FROM detections WHERE camera=? AND feature=? AND hash=?",
            (camera, feature, frame_hash),
        )
        now = time.time()
        con.executemany(
            "INSERT INTO detections(camera,feature,hash,rank,x,y,w,h,conf,status,sig,ts) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                (camera, feature, frame_hash, i, b["x"], b["y"], b["w"], b["h"], float(c), AUTO, sig, now)
                for i, (b, c) in enumerate(found)
            ],
        )
        con.execute("COMMIT")
        return True
    except Exception:
        con.execute("ROLLBACK")
        raise
    finally:
        con.close()


def set_box(camera: str, feature: str, frame_hash: str, box: dict, status: str = MANUAL) -> None:
    """Human decision: this frame's object is ``box``; other candidates are dropped."""
    if status not in HUMAN:
        raise ValueError(f"status must be one of {HUMAN}")
    box = vision_settings.clean_box(box)
    con = db.connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        previous = con.execute(
            "SELECT conf FROM detections WHERE camera=? AND feature=? AND hash=? AND rank=0",
            (camera, feature, frame_hash),
        ).fetchone()
        con.execute(
            "DELETE FROM detections WHERE camera=? AND feature=? AND hash=?",
            (camera, feature, frame_hash),
        )
        con.execute(
            "INSERT INTO detections(camera,feature,hash,rank,x,y,w,h,conf,status,sig,ts) "
            "VALUES (?,?,?,0,?,?,?,?,?,?,'',?)",
            (camera, feature, frame_hash, box["x"], box["y"], box["w"], box["h"],
             float(previous["conf"]) if previous else 1.0, status, time.time()),
        )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    finally:
        con.close()
    vision_settings.purge_derived(camera, feature)


def clear_box(camera: str, feature: str, frame_hash: str) -> None:
    """Forget a frame's detections (including human ones)."""
    con = db.connect()
    try:
        con.execute(
            "DELETE FROM detections WHERE camera=? AND feature=? AND hash=?",
            (camera, feature, frame_hash),
        )
        con.commit()
    finally:
        con.close()
    vision_settings.purge_derived(camera, feature)


def vision_snapshot(camera: str, feature: str) -> dict | None:
    """What a freeze records so the version's derived vectors can be reproduced.

    The filter, mask and detector settings, the cache signature they produce, and (when the
    mask is anchored) the trusted box per frame hash. ``None`` when nothing is configured.
    """
    settings = vision_settings.get(camera, feature)
    if not any(settings.values()):
        return None
    snap: dict = {**settings, "signature": vision_settings.signature(camera, feature)}
    if vision_settings.anchored(settings):
        sig = vision_settings.detection_signature(settings)
        threshold = settings["detector"]["threshold"]
        boxes = {}
        for h, rows in load(camera, feature).items():
            box = trusted_box(rows, sig, threshold)
            if box:
                boxes[h] = {k: round(v, 4) for k, v in box.items()}
        snap["detections"] = boxes
    return snap
