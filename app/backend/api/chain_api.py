"""Chain canvas: the per-camera map of Ingest -> product ROI -> feature ROIs (see ``chain.py``).

Boxes are created, connected and deleted through the ROI endpoints; this router serves the map and its layout.
"""
from __future__ import annotations

import chain
import datamodel
import db
import dedup_box
import flow
from api.cameras import require_camera
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class EvaluationBody(BaseModel):
    box: str | None = None


class DetachedBody(BaseModel):
    detached: bool = True


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


@router.put("/cameras/{camera}/chain/{feature:path}/evaluation")
def put_evaluation(camera: str, feature: str, body: EvaluationBody) -> dict:
    """Pick the Evaluation box a Classifier shows on its cards (``box`` null clears it)."""
    require_camera(camera)
    try:
        flow.set_feature_evaluation(camera, feature, body.box)
    except flow.FlowError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return chain.get_canvas(camera)


@router.put("/cameras/{camera}/chain/{feature:path}/detached")
def put_detached(camera: str, feature: str, body: DetachedBody) -> dict:
    """Draw a feature Classifier without its line from Ingest (it still reads the whole camera), or draw the line again."""
    require_camera(camera)
    if datamodel.get_roi(camera, feature) is None or datamodel.get_roi(camera, feature).role == "classify":
        raise HTTPException(status_code=404, detail="Unknown feature Classifier")
    if body.detached:
        db.set_setting(camera, f"{db.DETACHED_KEY}{feature}", "1")
    else:
        db.delete_setting(camera, f"{db.DETACHED_KEY}{feature}")
    return chain.get_canvas(camera)


class DedupInputBody(BaseModel):
    box: str | None = None


@router.put("/cameras/{camera}/chain/{feature:path}/dedup")
def put_dedup_input(camera: str, feature: str, body: DedupInputBody) -> dict:
    """Make a Dedup box the one a Classifier reads through (``box`` null removes it)."""
    require_camera(camera)
    try:
        dedup_box.set_input(camera, feature, body.box)
    except dedup_box.DedupBoxError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return chain.get_canvas(camera)
