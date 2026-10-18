"""Chain canvas: the per-camera map of Ingest -> product ROI -> feature ROIs (see ``chain.py``).

Boxes are created, connected and deleted through the ROI endpoints; this router serves the map and its layout.
"""
from __future__ import annotations

import chain
from api.cameras import require_camera
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class LayoutBody(BaseModel):
    nodes: dict[str, dict] = {}
    viewport: dict | None = None


@router.get("/cameras/{camera}/chain")
def get_chain(camera: str) -> dict:
    require_camera(camera)
    return chain.get_canvas(camera)


@router.put("/cameras/{camera}/chain/layout")
def put_layout(camera: str, body: LayoutBody) -> dict:
    require_camera(camera)
    try:
        chain.save_layout(camera, body.model_dump())
    except chain.ChainError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return chain.get_canvas(camera)


@router.get("/cameras/{camera}/chain/delete-preview")
def delete_preview(camera: str, feature: str) -> dict:
    """What deleting the ROI box ``feature`` would remove, for the confirmation."""
    require_camera(camera)
    try:
        return chain.delete_preview(camera, feature)
    except chain.ChainError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
