"""Per-feature vision settings (filter, object mask, detector): catalogue, save/load, preview, detection."""
from __future__ import annotations

import cv2
import datamodel
import detections
import detector
import engine
import labels
import masking
import preprocess
import vision_settings
from api import jobs
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


class Box(BaseModel):
    x: float
    y: float
    w: float
    h: float


class Exemplar(BaseModel):
    frame: str
    box: Box


class DetectorChoice(BaseModel):
    exemplars: list[Exemplar] = []
    topk: int = vision_settings.DEFAULT_TOPK
    threshold: float = vision_settings.DEFAULT_THRESHOLD
    method: str = vision_settings.DEFAULT_METHOD
    size: int = vision_settings.DEFAULT_INPUT_SIZE


class VisionSettings(BaseModel):
    filter: FilterChoice | None = None
    mask: MaskChoice | None = None
    detector: DetectorChoice | None = None


class BoxUpdate(BaseModel):
    box: Box
    status: str = detections.MANUAL


class RestoreRow(Box):
    conf: float = 1.0
    status: str = detections.AUTO


class RestoreBody(BaseModel):
    rows: list[RestoreRow] = []


class PreviewRequest(VisionSettings):
    frame: str


def _clean(body: VisionSettings) -> dict:
    return {
        "filter": body.filter.model_dump() if body.filter else None,
        "mask": body.mask.model_dump() if body.mask else None,
        "detector": body.detector.model_dump() if body.detector else None,
    }


_BAD_SETTINGS = (preprocess.FilterError, masking.MaskError, vision_settings.SettingsError)


def _frame_offset(camera: str, feature: str, frame_hash: str, proposed: dict) -> tuple[float, float]:
    """Mask shift for one frame under ``proposed`` settings (zero when not anchored/detected)."""
    cleaned = vision_settings.validate(proposed)
    return detections.offsets(camera, feature, cleaned).get(frame_hash, (0.0, 0.0))


def _frame_hash(camera: str, frame: str) -> str:
    frame_path(camera, frame)  # 404 for unknown frames
    return labels.frame_hash(camera, frame)


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
    except _BAD_SETTINGS as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/cameras/{camera}/vision/{feature}/preview")
def preview(camera: str, feature: str, body: PreviewRequest) -> Response:
    """ROI crop of one frame with the *proposed* (unsaved) filter and enabled mask applied, as JPEG."""
    require_feature(camera, feature)
    path = frame_path(camera, body.frame)
    frame_hash = labels.frame_hash(camera, body.frame)
    try:
        img = engine.resolve_roi(camera, feature).crop(curation.load_image(path))
        if body.filter:
            img = preprocess.apply(img, body.filter.name, body.filter.params)
        if body.mask and body.mask.enabled:
            offset = _frame_offset(camera, feature, frame_hash, _clean(body))
            img = masking.apply(img, body.mask.shape, offset)
    except _BAD_SETTINGS as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise HTTPException(status_code=415, detail="Cannot encode preview")
    return Response(content=buf.tobytes(), media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/vision/detector")
def detector_info() -> dict:
    return {
        "available": detector.available(),
        "model": detector.MODEL_ID,
        "model_cached": detector.model_ready(),
        "download_mb": detector.MODEL_DOWNLOAD_MB,
        "download_source": detector.MODEL_SOURCE,
        "cache_dir": detector.model_cache_dir(),
        "max_exemplars": vision_settings.MAX_EXEMPLARS,
        "topk": list(vision_settings.TOPK_RANGE),
        "input_sizes": list(vision_settings.INPUT_SIZES),
        "methods": list(vision_settings.METHODS),
    }


class DetectBody(BaseModel):
    accept_download: bool = False


@router.post("/cameras/{camera}/vision/{feature}/detect")
def detect(camera: str, feature: str, body: DetectBody = DetectBody()) -> dict:
    """Run the detector over the feature's frames as a background job."""
    require_feature(camera, feature)
    settings = vision_settings.get(camera, feature)
    if not settings["detector"] or not settings["detector"]["exemplars"]:
        raise HTTPException(status_code=422, detail="Save at least one exemplar first")
    uses_model = settings["detector"]["method"] == "model"  # template matching needs neither torch nor the model
    if uses_model and not detector.available() and detector._backend is None:
        raise HTTPException(
            status_code=503,
            detail="The detector needs torch and transformers (pip install -r requirements-detector.txt)",
        )

    if uses_model and not detector.model_ready() and not body.accept_download:
        raise HTTPException(
            status_code=409,
            detail=(
                f"The detector model ({detector.MODEL_ID}, about {detector.MODEL_DOWNLOAD_MB} MB from "
                f"{detector.MODEL_SOURCE}) is not downloaded yet. Confirm the download first."
            ),
        )

    def work(report):
        return detector.run(camera, feature, report, allow_download=body.accept_download)

    return jobs.registry.submit("detect", camera, work, feature=feature).to_dict()


@router.get("/cameras/{camera}/vision/{feature}/detections")
def list_detections(camera: str, feature: str, review_only: bool = False) -> dict:
    """Per-frame detections with a review state.

    ``state``: ``human`` (reviewed/manual), ``trusted`` (auto, confident), ``review`` (auto,
    below the threshold), ``missing`` (nothing found), ``none`` (never detected).
    """
    require_feature(camera, feature)
    settings = vision_settings.get(camera, feature)
    det = settings["detector"]
    threshold = det["threshold"] if det else vision_settings.DEFAULT_THRESHOLD
    sig = vision_settings.detection_signature(settings)
    stored = detections.load(camera, feature)
    hmap = labels.hash_map(camera)
    rows = []
    for frame in datamodel.frames_for_feature(camera, feature):
        found = stored.get(labels.frame_hash(camera, frame, hmap))
        if not found:
            state = "none"
        elif found[0]["status"] in detections.HUMAN:
            state = "human"
        elif found[0]["sig"] != sig:
            state = "none"
        elif found[0]["conf"] >= threshold:
            state = "trusted"
        else:
            state = "review"
        boxes = [] if state == "none" else found
        rows.append({
            "frame": frame,
            "state": state,
            "status": found[0]["status"] if found else None,
            "boxes": [{k: b[k] for k in ("x", "y", "w", "h", "conf")} for b in boxes],
        })
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["state"]] = counts.get(r["state"], 0) + 1  # over all frames, not just the queue
    if review_only:
        rows = [r for r in rows if r["state"] in ("review", "none")]
    return {"threshold": threshold, "frames": rows, "counts": counts}


@router.put("/cameras/{camera}/vision/{feature}/detections/{frame}")
def put_detection(camera: str, feature: str, frame: str, body: BoxUpdate) -> dict:
    """Human decision for one frame: this box is the object (``manual``, or ``reviewed`` to accept)."""
    require_feature(camera, feature)
    try:
        detections.set_box(camera, feature, _frame_hash(camera, frame), body.box.model_dump(), body.status)
    except (ValueError, vision_settings.SettingsError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/cameras/{camera}/vision/{feature}/detections/{frame}/restore")
def restore_detection(camera: str, feature: str, frame: str, body: RestoreBody) -> dict:
    """Undo a decision: put the frame's detections back as they were (an empty list leaves it without any)."""
    require_feature(camera, feature)
    sig = vision_settings.detection_signature(vision_settings.get(camera, feature))
    try:
        detections.restore(camera, feature, _frame_hash(camera, frame), [r.model_dump() for r in body.rows], sig)
    except (ValueError, vision_settings.SettingsError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True}


@router.delete("/cameras/{camera}/vision/{feature}/detections/{frame}")
def delete_detection(camera: str, feature: str, frame: str) -> dict:
    require_feature(camera, feature)
    detections.clear_box(camera, feature, _frame_hash(camera, frame))
    return {"ok": True}
