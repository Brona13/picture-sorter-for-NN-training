"""Project verdicts: summary, paged listing and the user's own decisions (see ``verdicts.py``)."""
from __future__ import annotations

import db
import verdicts
from api.cameras import require_camera
from api.frames_api import frame_path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


PER_PAGE_OPTIONS = [12, 24, 48, 96]
COLS_OPTIONS = [3, 4, 5, 6, 8]


def _grid_settings(camera: str) -> dict:
    """Camera-wide grid choice of the Verdict page (it has no ROI, so it is kept apart from Classify's)."""

    def pick(kind: str, options: list[int], default: int) -> int:
        try:
            value = int(db.get_setting(camera, f"verdict.grid.{kind}") or default)
        except (TypeError, ValueError):
            value = default
        return value if value in options else default

    return {
        "per_page": pick("perpage", PER_PAGE_OPTIONS, 24),
        "cols": pick("cols", COLS_OPTIONS, 4),
        "per_page_options": PER_PAGE_OPTIONS,
        "cols_options": COLS_OPTIONS,
    }


class GridBody(BaseModel):
    per_page: int
    cols: int


@router.put("/cameras/{camera}/verdicts/grid-settings")
def save_grid_settings(camera: str, body: GridBody) -> dict:
    require_camera(camera)
    if body.per_page not in PER_PAGE_OPTIONS or body.cols not in COLS_OPTIONS:
        raise HTTPException(status_code=422, detail="Unsupported per_page or cols value.")
    db.set_setting(camera, "verdict.grid.perpage", str(body.per_page))
    db.set_setting(camera, "verdict.grid.cols", str(body.cols))
    return _grid_settings(camera)


class DecisionBody(BaseModel):
    frame: str
    cls: str | None = None  # None clears the decision


@router.get("/cameras/{camera}/verdicts/summary")
def summary(camera: str) -> dict:
    require_camera(camera)
    return verdicts.summary(camera)


@router.get("/cameras/{camera}/verdicts")
def listing(camera: str, status: str = "all", page: int = 1, per_page: int | None = None) -> dict:
    """Paged verdicts; without ``per_page`` the page uses the stored grid setting (returned as ``settings``)."""
    require_camera(camera)
    settings = _grid_settings(camera)
    try:
        return {**verdicts.listing(camera, status, page, per_page or settings["per_page"]), "settings": settings}
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
