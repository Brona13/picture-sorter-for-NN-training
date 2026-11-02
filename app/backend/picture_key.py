"""A short key that changes whenever the pictures a Classifier shows change (plan ``plans/two-step-solution.md``, stage 5).

The thumbnails and cut-outs of a Classifier are other pixels when its rectangle moves, its picture edits or filter change,
the detector it is anchored to is run again, or the Box it is anchored to gets other margins. The browser keeps a picture it
already has for the same address, so the address carries this key (``api.ts`` ``setPictureVersion``); the page records it
before the cards render.
"""
from __future__ import annotations

import hashlib

import anchor
import classify
import datamodel
import dedup_basis
import flow


def of(camera: str, feature: str, roi: "datamodel.ROI | None" = None, con=None) -> str:
    """The key of one Classifier's pictures ("" for an unknown ROI)."""
    roi = roi or datamodel.get_roi(camera, feature)
    if roi is None:
        return ""
    key = classify._roi_cache_key(roi, camera, feature, con)
    spec = anchor.get_anchor(camera, feature, con)
    if spec and spec["detector"] in flow.load_graph(camera)["nodes"]:
        flow.load_stored(camera, spec["detector"])  # a Box makes its rectangles again first, so the run below is current
        key += "|" + dedup_basis._run_hash(camera, spec["detector"])
    return hashlib.sha1(key.encode()).hexdigest()[:12]
