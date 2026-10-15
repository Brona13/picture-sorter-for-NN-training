"""Rule-based tools: the edge-angle rule (settings, live preview, run over a feature)."""
from __future__ import annotations

import base64

import cv2
import edge_angle
import vision_settings
from api import jobs
from api.cameras import require_feature
from api.frames_api import frame_path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class PointBody(BaseModel):
    x: float
    y: float


class ExpectedBody(BaseModel):
    angle: float
    tolerance: float = edge_angle.DEFAULT_TOLERANCE
    polarity: str


class EdgeAngleBody(BaseModel):
    p1: PointBody
    p2: PointBody
    half_width: float = edge_angle.DEFAULT_HALF_WIDTH
    points: int = edge_angle.DEFAULT_POINTS
    expected: ExpectedBody | None = None


class SaveBody(BaseModel):
    settings: EdgeAngleBody | None = None


class PreviewBody(BaseModel):
    frame: str
    settings: EdgeAngleBody


def _clean(body: EdgeAngleBody | None) -> dict | None:
    try:
        return edge_angle.clean(body.model_dump() if body else None)
    except edge_angle.SettingsError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _state(camera: str, feature: str) -> dict:
    settings = edge_angle.get(camera, feature)
    status = edge_angle.results_status(camera, feature)
    results = edge_angle.load_results(camera, feature) if status == "fresh" else {}
    return {
        "feature": feature,
        "settings": settings,
        "ranges": {
            "points": list(edge_angle.POINTS_RANGE),
            "half_width": list(edge_angle.HALF_WIDTH_RANGE),
            "tolerance": list(edge_angle.TOLERANCE_RANGE),
        },
        "defaults": {
            "points": edge_angle.DEFAULT_POINTS,
            "half_width": edge_angle.DEFAULT_HALF_WIDTH,
            "tolerance": edge_angle.DEFAULT_TOLERANCE,
        },
        "results": status,
        "summary": edge_angle.summarize(results, settings["expected"] if settings else None) if status == "fresh" else None,
    }


@router.get("/cameras/{camera}/rules/edge-angle/{feature}")
def get_edge_angle(camera: str, feature: str) -> dict:
    require_feature(camera, feature)
    return _state(camera, feature)


@router.put("/cameras/{camera}/rules/edge-angle/{feature}")
def put_edge_angle(camera: str, feature: str, body: SaveBody) -> dict:
    require_feature(camera, feature)
    edge_angle.put(camera, feature, _clean(body.settings))
    return _state(camera, feature)


@router.post("/cameras/{camera}/rules/edge-angle/{feature}/preview")
def preview(camera: str, feature: str, body: PreviewBody) -> dict:
    """Measure one frame with the *proposed* (unsaved) settings: angle, polarity, the points used,
    the fitted line, the band corners and the straightened band as a PNG data URI."""
    require_feature(camera, feature)
    path = frame_path(camera, body.frame)
    settings = _clean(body.settings)
    flt = vision_settings.get(camera, feature)["filter"]
    try:
        crop = edge_angle.filtered_crop(camera, feature, path, flt)
    except Exception as exc:  # noqa: BLE001 - unreadable image
        raise HTTPException(status_code=415, detail=f"Cannot read frame: {exc}") from exc
    result = edge_angle.measure(crop, settings)
    patch = edge_angle.band_patch(crop, settings)
    data_uri = None
    if patch is not None:
        ok, buf = cv2.imencode(".png", patch)
        if ok:
            data_uri = "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()
    return {
        "measurement": result,
        "verdict": edge_angle.verdict(result, settings["expected"]),
        "band": edge_angle.band_corners(crop.shape, settings),
        "patch": data_uri,
        "crop_size": [int(crop.shape[1]), int(crop.shape[0])],
    }


@router.post("/cameras/{camera}/rules/edge-angle/{feature}/run", status_code=202)
def run_edge_angle(camera: str, feature: str) -> dict:
    """Measure every live frame of the feature with the saved settings (a background job)."""
    require_feature(camera, feature)
    if edge_angle.get(camera, feature) is None:
        raise HTTPException(status_code=422, detail="Save the line first.")

    def work(report):
        return edge_angle.run(camera, feature, report)

    return jobs.registry.submit("edge_angle", camera, work, feature=feature).to_dict()
