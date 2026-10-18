"""Camera, product and feature listing endpoints (thin wrappers over ``datamodel``)."""
from __future__ import annotations

import config
import datamodel
import db
import tags as camera_tags
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


def require_camera(camera: str) -> str:
    """Return ``camera`` if it exists; 404 otherwise (also blocks path traversal)."""
    if camera not in datamodel.list_cameras():
        raise HTTPException(status_code=404, detail=f"Unknown camera: {camera}")
    return camera


def require_feature(camera: str, feature: str) -> str:
    """Accept any feature of this camera (product-scoped or shared) or its whole-frame variant."""
    require_camera(camera)
    known = set(datamodel.list_features(camera))
    whole = {config.WHOLE_FRAME_FEATURE} | {
        datamodel.compose_feature(p, config.WHOLE_FRAME_FEATURE)
        for p in datamodel.products(camera)
    }
    if feature not in known | whole:
        raise HTTPException(status_code=404, detail=f"Unknown feature: {feature}")
    return feature


@router.get("/cameras")
def list_cameras() -> list[str]:
    return datamodel.list_cameras()


@router.get("/cameras/{camera}/delete-preview")
def delete_preview(camera: str) -> dict:
    """What deleting the camera would remove, for the confirmation."""
    require_camera(camera)
    return {"camera": camera, "rows": db.camera_row_counts(camera), **datamodel.disk_usage(camera)}


@router.delete("/cameras/{camera}")
def delete_camera(camera: str, confirm: str = "") -> dict:
    """Delete a camera with everything related to it (irreversible). ``confirm`` must repeat the camera's name."""
    from api import jobs

    require_camera(camera)
    if confirm != camera:
        raise HTTPException(status_code=422, detail="Type the camera's name to confirm the delete.")
    if jobs.registry.busy(camera):
        raise HTTPException(status_code=409, detail="A job is still running on this camera; wait for it to finish.")
    return {"removed": datamodel.delete_camera(camera)}


@router.get("/cameras/{camera}/products")
def list_products(camera: str) -> list[str]:
    require_camera(camera)
    return datamodel.products(camera)


@router.get("/cameras/{camera}/features")
def list_features(camera: str, product: str | None = None) -> list[str]:
    require_camera(camera)
    if product is not None and product not in datamodel.products(camera):
        raise HTTPException(status_code=404, detail=f"Unknown product: {product}")
    return datamodel.list_features_for(camera, product)


class TagsRequest(BaseModel):
    tags: list[str]


@router.get("/tags")
def list_tags() -> list[dict]:
    """Every tag in use across all cameras, for autotype."""
    return camera_tags.all_tags(datamodel.list_cameras())


@router.get("/cameras/{camera}/tags")
def get_tags(camera: str) -> list[str]:
    require_camera(camera)
    return camera_tags.get(camera)


@router.put("/cameras/{camera}/tags")
def put_tags(camera: str, body: TagsRequest) -> list[str]:
    """Replace this camera's tags (removing a tag only affects this camera)."""
    require_camera(camera)
    try:
        return camera_tags.set_tags(camera, body.tags)
    except camera_tags.TagError as e:
        raise HTTPException(status_code=422, detail=str(e))
