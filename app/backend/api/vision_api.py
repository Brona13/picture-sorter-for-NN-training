"""Per-feature vision settings (filter and object mask): catalogue, save/load, live preview."""
from __future__ import annotations

import cv2
import engine
import masking
import preprocess
import vision_settings
from api.cameras import require_feature
from api.frames_api import frame_path
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

import curation

router = APIRouter()


class FilterChoice(BaseModel):
    name: str
    params: dict[str, float] = {}


class MaskChoice(BaseModel):
    enabled: bool = False
    shape: dict


class VisionSettings(BaseModel):
    filter: FilterChoice | None = None
    mask: MaskChoice | None = None


class PreviewRequest(VisionSettings):
    frame: str


def _clean(body: VisionSettings) -> dict:
    return {
        "filter": body.filter.model_dump() if body.filter else None,
        "mask": body.mask.model_dump() if body.mask else None,
    }


@router.get("/vision/filters")
def filters() -> dict:
    return {"filters": preprocess.FILTERS}


@router.get("/cameras/{camera}/vision/{feature}")
def get_settings(camera: str, feature: str) -> dict:
    require_feature(camera, feature)
    return vision_settings.get(camera, feature)


@router.put("/cameras/{camera}/vision/{feature}")
def put_settings(camera: str, feature: str, body: VisionSettings) -> dict:
    require_feature(camera, feature)
    try:
        return vision_settings.put(camera, feature, _clean(body))
    except (preprocess.FilterError, masking.MaskError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/cameras/{camera}/vision/{feature}/preview")
def preview(camera: str, feature: str, body: PreviewRequest) -> Response:
    """ROI crop of one frame with the *proposed* (unsaved) filter and enabled mask applied, as JPEG."""
    require_feature(camera, feature)
    path = frame_path(camera, body.frame)
    try:
        img = engine.resolve_roi(camera, feature).crop(curation.load_image(path))
        if body.filter:
            img = preprocess.apply(img, body.filter.name, body.filter.params)
        if body.mask and body.mask.enabled:
            img = masking.apply(img, body.mask.shape)
    except (preprocess.FilterError, masking.MaskError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise HTTPException(status_code=415, detail="Cannot encode preview")
    return Response(content=buf.tobytes(), media_type="image/jpeg", headers={"Cache-Control": "no-store"})
