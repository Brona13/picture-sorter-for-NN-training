"""Overview of every camera with its reference frame and ROIs (one request for the Overview page)."""
from __future__ import annotations

import datamodel
import db
import pipeline
import tags as camera_tags
import tools_used
import verdicts
from api.cameras import require_camera, require_feature
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
                    "tags": camera_tags.get(camera),
                    "verdicts": verdicts.summary(camera),
                    "products": datamodel.products(camera),
                    "classify_feature": datamodel.classify_feature(camera),
                    "rois": [{**_describe(camera, r, len(frames)), "pipeline": pipeline.stages(camera, r.name)} for r in rois],
                }
            )
    return {"cameras": cameras}


@router.get("/cameras/{camera}/pipeline")
def feature_pipeline(camera: str, feature: str) -> dict:
    """Where one ROI stands in the pipeline (for the step bar shown on the other pages)."""
    require_feature(camera, feature)
    return pipeline.stages(camera, feature)


@router.get("/cameras/{camera}/tools-used")
def camera_tools_used(camera: str) -> dict[str, bool]:
    """Which tools have left a trace on this camera (for the muted / colorful icons in the tool bar)."""
    require_camera(camera)
    return tools_used.used(camera)
