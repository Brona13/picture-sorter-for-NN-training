"""Overview of every camera with its reference frame and ROIs (one request for the Overview page)."""
from __future__ import annotations

import datamodel
import db
from api.roi_api import _describe
from fastapi import APIRouter

router = APIRouter()


@router.get("/overview")
def overview() -> dict:
    cameras = []
    with datamodel.render_snapshot():
        for camera in datamodel.list_cameras():
            frames = [p.name for p in datamodel.list_unsorted(camera)]
            ref = db.get_setting(camera, "reference_frame")
            if ref not in frames:
                ref = frames[0] if frames else None
            rois = datamodel.load_rois(camera)
            cameras.append(
                {
                    "camera": camera,
                    "frame_count": len(frames),
                    "picture_frame": ref,
                    "products": datamodel.products(camera),
                    "classify_feature": datamodel.classify_feature(camera),
                    "rois": [_describe(camera, r, len(frames)) for r in rois],
                }
            )
    return {"cameras": cameras}
