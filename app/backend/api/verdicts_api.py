"""Project verdicts: summary, paged listing and the user's own decisions (see ``verdicts.py``)."""
from __future__ import annotations

import verdicts
from api.cameras import require_camera
from api.frames_api import frame_path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class DecisionBody(BaseModel):
    frame: str
    cls: str | None = None  # None clears the decision


@router.get("/cameras/{camera}/verdicts/summary")
def summary(camera: str) -> dict:
    require_camera(camera)
    return verdicts.summary(camera)


@router.get("/cameras/{camera}/verdicts")
def listing(camera: str, status: str = "all", page: int = 1, per_page: int = 24) -> dict:
    require_camera(camera)
    try:
        return verdicts.listing(camera, status, page, per_page)
    except verdicts.VerdictError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.put("/cameras/{camera}/verdicts/decision")
def decide(camera: str, body: DecisionBody) -> dict:
    require_camera(camera)
    frame_path(camera, body.frame)
    try:
        verdicts.decide(camera, body.frame, body.cls)
    except verdicts.VerdictError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"item": verdicts.record_for(camera, body.frame), "summary": verdicts.summary(camera)}
