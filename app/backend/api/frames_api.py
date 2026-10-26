"""Serve source frames (read-only) and ROI cutout thumbnails."""
from __future__ import annotations

import io
from pathlib import Path

import anchor
import roi_input
import config
import cv2
import numpy as np
import datamodel
import db
import engine
import labels
import thumbs
from api.cameras import require_camera
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel

router = APIRouter()
_BROWSER_TYPES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def frame_path(camera: str, frame: str) -> Path:
    """Resolve a frame name inside the camera's immutable inbox (no traversal)."""
    require_camera(camera)
    if Path(frame).name != frame or Path(frame).suffix.lower() not in config.IMAGE_EXTENSIONS:
        raise HTTPException(status_code=404, detail=f"Unknown frame: {frame}")
    path = datamodel.unsorted_dir(camera) / frame
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Unknown frame: {frame}")
    return path


def _roi_tuple(camera: str, feature: str | None, path: Path | None = None) -> tuple:
    """The rectangle to cut: the ROI's own, or - for a detector-anchored ROI - the one placed on this picture."""
    feature = feature or config.WHOLE_FRAME_FEATURE
    roi = engine.resolve_roi(camera, feature)
    if path is not None and anchor.get_anchor(camera, feature):
        with Image.open(path) as picture:
            width, height = picture.size
        placed = engine.resolve_roi_for_frame(camera, feature, labels.hash_map(camera).get(path.name, ""), width, height)
        if placed is None:
            raise HTTPException(status_code=404, detail="The detector found no anchor on this picture.")
        roi = placed
    edits = roi_input.tuple_part(camera, feature)
    if edits and path is not None:
        with Image.open(path) as picture:
            blank = np.zeros((picture.height, picture.width, 3), np.uint8)
        try:
            roi_input.edited(camera, feature, blank, path.name)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="No edited picture here: the detector found no target on this picture.") from exc
    return (roi.name, roi.x, roi.y, roi.w, roi.h, edits) if edits else (roi.name, roi.x, roi.y, roi.w, roi.h)


def _cached(request: Request, etag: str, content: bytes, media_type: str) -> Response:
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=content, media_type=media_type, headers=headers)


@router.get("/cameras/{camera}/frames")
def list_frames(camera: str, product: str | None = None, feature: str | None = None) -> dict:
    """Frames offered as drawing backgrounds (deleted ones excluded); falls back to all frames when a product has none.

    ``feature`` narrows to the pictures that Classifier applies to (its products), so its ROI is drawn on a right picture."""
    require_camera(camera)
    if feature is not None and datamodel.get_roi(camera, feature) is None:
        raise HTTPException(status_code=404, detail=f"Unknown ROI: {feature}")
    if product is not None and product not in datamodel.products(camera):
        raise HTTPException(status_code=404, detail=f"Unknown product: {product}")
    deleted = db.deleted_frames_of(camera)  # deleted frames are never offered as a drawing background
    all_names = [p.name for p in datamodel.list_unsorted(camera) if p.name not in deleted]
    scoped = datamodel.frames_for_feature(camera, feature) if feature else datamodel.frames_of_product(camera, product)
    names = [n for n in scoped if n not in deleted]
    showing_all = not names
    return {
        "frames": all_names if showing_all else names,
        "showing_all": showing_all,
        "total": len(all_names),
        "reference_frame": db.get_setting(camera, "reference_frame"),
    }


class ReferenceRequest(BaseModel):
    frame: str


@router.put("/cameras/{camera}/reference-frame")
def set_reference_frame(camera: str, body: ReferenceRequest) -> dict:
    frame_path(camera, body.frame)
    db.set_setting(camera, "reference_frame", body.frame)
    return {"reference_frame": body.frame}


@router.get("/cameras/{camera}/frames/{frame}/image")
def frame_image(camera: str, frame: str, request: Request) -> Response:
    path = frame_path(camera, frame)
    if path.suffix.lower() in _BROWSER_TYPES:
        return FileResponse(path)  # sets ETag / Last-Modified
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)  # e.g. TIFF: not browser-displayable
    if img is None:
        raise HTTPException(status_code=415, detail=f"Cannot decode frame: {frame}")
    ok, buf = cv2.imencode(".png", img)
    st = path.stat()
    return _cached(request, f'"{st.st_mtime_ns}-{st.st_size}"', buf.tobytes(), "image/png")


@router.get("/cameras/{camera}/frames/{frame}/cutout")
def frame_cutout(camera: str, frame: str, request: Request, feature: str) -> Response:
    """The picture's cutout of ``feature`` at full resolution (PNG): a ROI, or a Dedup box fed by a detector target
    (the box the detector found). 404 when the detector found no box on this picture."""
    path = frame_path(camera, frame)
    roi_tuple = _roi_tuple(camera, feature, path)  # raises 404 when there is no box on this picture
    mtime = path.stat().st_mtime
    etag = f'"cutout-{mtime}-{hash(roi_tuple) & 0xFFFFFFFF:x}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    try:
        crop = engine.crop_for_frame(camera, feature, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    ok, buf = cv2.imencode(".png", crop)
    if not ok:
        raise HTTPException(status_code=415, detail=f"Cannot render the cutout of {frame}")
    return _cached(request, etag, buf.tobytes(), "image/png")


@router.get("/cameras/{camera}/frames/{frame}/thumb")
def frame_thumb(
    camera: str,
    frame: str,
    request: Request,
    feature: str | None = None,
    variant: str = "cutout",
    size: int = 128,
) -> Response:
    """ROI cutout thumbnail (JPEG). ``variant=square`` gives a centre-cropped square
    of ``size`` px; the default is the grid cutout. No ``feature`` = whole frame."""
    path = frame_path(camera, frame)
    if variant not in ("cutout", "square"):
        raise HTTPException(status_code=422, detail="variant must be 'cutout' or 'square'")
    if not 16 <= size <= 512:
        raise HTTPException(status_code=422, detail="size must be between 16 and 512")
    roi_tuple = _roi_tuple(camera, feature, path)
    mtime = path.stat().st_mtime
    etag = f'"{variant}-{size}-{mtime}-{hash(roi_tuple) & 0xFFFFFFFF:x}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    try:
        if variant == "cutout":
            data = thumbs.cutout_thumb(str(path), roi_tuple, mtime)
        else:
            buf = io.BytesIO()
            thumbs.square_thumb(str(path), roi_tuple, mtime, size).save(buf, format="JPEG", quality=80)
            data = buf.getvalue()
    except Exception as exc:  # noqa: BLE001 - unreadable image
        raise HTTPException(status_code=415, detail=f"Cannot render thumbnail: {exc}") from exc
    return _cached(request, etag, data, "image/jpeg")
