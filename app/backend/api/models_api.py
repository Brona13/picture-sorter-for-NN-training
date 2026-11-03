"""Models: the datasets (frozen step-2 Exports with rectangles) a DS dataset collection can be built from."""
from __future__ import annotations

import model_sets
from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.get("/models/datasets")
def list_datasets(size: str | None = None) -> dict:
    """Per camera, the step-2 freezes that hold rectangles, with their OK / NG counts and picture sizes. ``size=200x200`` lists only
    freezes whose pictures all have that size."""
    try:
        return model_sets.datasets(size)
    except model_sets.SizeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
