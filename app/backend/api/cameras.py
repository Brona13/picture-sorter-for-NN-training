"""Camera, product and feature listing endpoints (thin wrappers over ``datamodel``)."""
from __future__ import annotations

import datamodel
from fastapi import APIRouter, HTTPException

router = APIRouter()


def require_camera(camera: str) -> str:
    """Return ``camera`` if it exists; 404 otherwise (also blocks path traversal)."""
    if camera not in datamodel.list_cameras():
        raise HTTPException(status_code=404, detail=f"Unknown camera: {camera}")
    return camera


@router.get("/cameras")
def list_cameras() -> list[str]:
    return datamodel.list_cameras()


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
