"""Where on its picture a Classifier (an ROI) looks: the *region* it cuts.

A Classifier's region is decided by the line into it and by one choice:

* ``as_is`` - it uses the picture exactly as it comes in: the whole picture from Ingest, the output picture of a
  Picture edits box, or the box a detector found (an anchor in mode ``box``). The ROI row's rectangle is **not used**
  and no rectangle is drawn. A new Classifier starts like this: there is no default rectangle.
* ``own`` - the user's own rectangle, drawn on what comes in (on the box's output picture, or relative to the found box:
  an anchor in mode ``rect``). Classifiers made before v1.117.0 are all ``own``: they keep their rectangle and their scores.
* ``own_pending`` - ``own`` was chosen but the rectangle is not drawn yet: the Classifier has no region, so no picture is
  scored or shown until it is saved (``mark_drawn``).

Ingest gives whole pictures, always: ``own`` is not offered for a Classifier that reads Ingest (to cut a region, use a
Picture edits box or a detector); one that already is ``own`` keeps it until switched to ``as_is``.

For an anchored Classifier the mode follows the anchor (``box`` -> ``as_is``, ``rect`` -> ``own``, or ``own_pending`` until the
rectangle has been placed and saved); switching a Classifier that had no rectangle to ``rect`` starts from the found box.
Stored in the camera setting ``roi.region.<feature>`` as ``as_is`` or ``own_pending``; no setting means ``own`` (the
legacy default). The ``rois`` table is unchanged: its rectangle is just ignored while the mode is ``as_is``.
"""
from __future__ import annotations

import anchor
import datamodel
import db
import roi_input
from roi import ROI

KEY_PREFIX = "roi.region."
AS_IS, OWN, OWN_PENDING = "as_is", "own", "own_pending"


class RegionError(ValueError):
    """That region choice is not possible for this Classifier."""


def _key(feature: str) -> str:
    return f"{KEY_PREFIX}{feature}"


def get_region(camera: str, feature: str, con=None) -> str:
    """``as_is``, ``own`` or ``own_pending`` (see the module text)."""
    spec = anchor.get_anchor(camera, feature, con)
    if spec and spec.get("mode") != "rect":
        return AS_IS
    if con is None:
        raw = db.get_setting(camera, _key(feature))
    else:
        row = con.execute("SELECT value FROM settings WHERE camera=? AND key=?", (camera, _key(feature))).fetchone()
        raw = row["value"] if row else None
    if spec:  # anchored with a rectangle of its own: own, or not placed yet
        return OWN_PENDING if raw == OWN_PENDING else OWN
    return raw if raw in (AS_IS, OWN_PENDING) else OWN


def full_frame(roi: ROI) -> ROI:
    """The same ROI (name, role, classes, products) over the whole picture."""
    return ROI(name=roi.name, x=0.0, y=0.0, w=1.0, h=1.0, role=roi.role, classes=roi.classes, products=roi.products)


def source_kind(camera: str, feature: str) -> str:
    """What the Classifier reads: ``detector`` (anchored), ``edits`` (a Picture edits box) or ``ingest`` (whole pictures)."""
    if anchor.get_anchor(camera, feature):
        return "detector"
    return "edits" if roi_input.get_input(camera, feature) else "ingest"


def set_region(camera: str, feature: str, mode: str) -> str:
    """Choose ``as_is`` or ``own``. Returns the stored mode (``own`` becomes ``own_pending`` until a rectangle is saved)."""
    roi = datamodel.get_roi(camera, feature)
    if roi is None:
        raise RegionError(f"Unknown ROI: {feature}")
    if mode not in (AS_IS, OWN):
        raise RegionError("The region is as_is or own.")
    if anchor.get_anchor(camera, feature):
        raise RegionError("This Classifier follows a detector box: choose 'the found box' or 'my own rectangle' in the Anchor section.")
    current = get_region(camera, feature)
    if mode == AS_IS:
        db.set_setting(camera, _key(feature), AS_IS)
        return AS_IS
    if current in (OWN, OWN_PENDING):
        return current
    if source_kind(camera, feature) == "ingest":
        raise RegionError("Ingest gives whole pictures. To use a region of them, connect a Picture edits box or a detector first.")
    rois = datamodel.load_rois(camera)  # start from the whole picture: nothing is drawn until the user does
    for r in rois:
        if r.name == feature:
            r.x, r.y, r.w, r.h = 0.0, 0.0, 1.0, 1.0
    datamodel.save_rois(camera, rois)
    db.set_setting(camera, _key(feature), OWN_PENDING)
    return OWN_PENDING


def mark_drawn(camera: str, feature: str) -> None:
    """The rectangle was saved: ``own_pending`` becomes ``own``."""
    if db.get_setting(camera, _key(feature)) == OWN_PENDING:
        db.delete_setting(camera, _key(feature))


def clear(camera: str, feature: str) -> None:
    db.delete_setting(camera, _key(feature))
