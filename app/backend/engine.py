"""ROI resolution shared by scoring, thumbnails, and exports."""
from __future__ import annotations

import config
import datamodel
from roi import ROI


def resolve_roi(camera: str, feature: str) -> ROI:
    """Return a named ROI or the explicit whole-frame pseudo-feature."""
    roi = datamodel.get_roi(camera, feature)
    if roi is not None:
        return roi
    return ROI.full_frame(feature or config.WHOLE_FRAME_FEATURE)
