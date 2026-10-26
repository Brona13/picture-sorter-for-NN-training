"""Log endpoints: the frontend reports its errors here; the newest records can be read back."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

import applog

router = APIRouter()
MAX_RECORDS = 50  # per call
MAX_TEXT = 4000  # characters kept of a message, stack or one extra value


class ClientRecord(BaseModel):
    level: str = "error"
    message: str = ""
    request_id: str | None = None
    camera: str | None = None
    url: str | None = None
    stack: str | None = None
    breadcrumbs: list[str] = Field(default_factory=list)
    extra: dict[str, Any] = Field(default_factory=dict)


class ClientBatch(BaseModel):
    records: list[ClientRecord]


def _clip(value: Any) -> Any:
    return value[:MAX_TEXT] if isinstance(value, str) else value


@router.post("/logs")
def report(batch: ClientBatch) -> dict[str, int]:
    """Store what the browser saw. Capped in count and size; picture data is never sent by the client."""
    taken = batch.records[:MAX_RECORDS]
    for r in taken:
        extra = {k: _clip(v) for k, v in list(r.extra.items())[:20]}
        applog.record_external(
            r.level, _clip(r.message), "frontend",
            request_id=r.request_id, camera=r.camera, url=_clip(r.url), stack=_clip(r.stack),
            breadcrumbs=[_clip(b) for b in r.breadcrumbs[-20:]], **{f"x_{k}": v for k, v in extra.items()},
        )
    return {"stored": len(taken)}


@router.get("/logs")
def read(level: str | None = None, source: str | None = None, camera: str | None = None,
         request_id: str | None = None, since_restart: bool = False, limit: int = 200) -> list[dict[str, Any]]:
    applog.flush()
    return applog.query(level=level, source=source, camera_name=camera, request=request_id,
                        since=applog.STARTED if since_restart else None, limit=limit)
