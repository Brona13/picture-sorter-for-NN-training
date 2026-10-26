"""ROI resolution shared by scoring, thumbnails, and exports."""
from __future__ import annotations

from pathlib import Path

import config
import datamodel
from roi import ROI


def resolve_roi(camera: str, feature: str) -> ROI:
    """Return a named ROI or the explicit whole-frame pseudo-feature."""
    roi = datamodel.get_roi(camera, feature)
    if roi is not None:
        return roi
    return ROI.full_frame(feature or config.WHOLE_FRAME_FEATURE)


def resolve_roi_for_frame(camera: str, feature: str, frame_hash: str, img_w: int, img_h: int) -> ROI | None:
    """The ROI on one picture: the static one, or - for a detector-anchored ROI - the rectangle placed from the box
    the detector found on this picture (``None`` when it found none). See ``anchor.py``."""
    roi = resolve_roi(camera, feature)
    import anchor  # noqa: PLC0415

    spec = anchor.get_anchor(camera, feature)
    if spec is None:
        return roi
    spec = anchor.effective(camera, feature, spec)
    entry = anchor._entry(camera, spec["detector"], spec["target"], frame_hash)
    placed = anchor.rect_for(spec, entry, roi.name, img_w, img_h)
    if placed is None:
        return None
    return ROI(name=roi.name, x=placed.x, y=placed.y, w=placed.w, h=placed.h, role=roi.role, classes=roi.classes, products=roi.products)


def crop_for_frame(camera: str, feature: str, frame_path):
    """The picture's ROI crop (anchored ROIs: cut where the detector's box is). Raises ``FileNotFoundError`` when
    the picture cannot be read or has no rectangle (no anchor box), which callers already treat as "skip"."""
    import curation  # noqa: PLC0415
    import labels  # noqa: PLC0415

    path = Path(frame_path)
    import roi_input  # noqa: PLC0415

    image = roi_input.edited(camera, feature, curation.load_image(path), path.name)  # a ROI fed by a Picture edits box reads its output picture
    import anchor  # noqa: PLC0415

    spec = anchor.get_anchor(camera, feature)
    if spec and anchor.group_slots(camera, spec):  # an anchor on all the numbered boxes of a target: they go side by side
        entries = anchor.group_entries(camera, spec, labels.hash_map(camera).get(path.name, ""))
        crop = anchor.group_crop(spec, entries, feature, image) if entries else None
        if crop is None:
            raise FileNotFoundError(f"No anchor boxes on {path.name}")
        return crop
    roi = resolve_roi_for_frame(camera, feature, labels.hash_map(camera).get(path.name, ""), image.shape[1], image.shape[0])
    if roi is None:
        raise FileNotFoundError(f"No anchor box on {path.name}")
    return roi.crop(image)
