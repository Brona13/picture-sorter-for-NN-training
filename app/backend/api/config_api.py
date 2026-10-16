"""App-wide configuration: which scoring methods take part in the flow."""
from __future__ import annotations

import embedding
import methods_config
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


def _payload() -> dict:
    return {
        "methods": methods_config.describe(),
        "device": embedding.active_device(),
        "device_label": embedding.device_label(),
    }


@router.get("/config/methods")
def get_methods() -> dict:
    return _payload()


class MethodsBody(BaseModel):
    active: list[str]


@router.put("/config/methods")
def put_methods(body: MethodsBody) -> dict:
    try:
        methods_config.set_active(body.active)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _payload()
