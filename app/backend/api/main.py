"""FastAPI application factory.

Domain modules are imported flat (``import datamodel``); ``app/backend`` must be on
``sys.path`` (``conftest.py`` for tests, ``run.sh`` for the server). Paths come from
``config`` and are read at call time, so tests can point them at temp directories.
"""
from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

import db  # noqa: E402
from api import cameras, classify_api, frames_api, ingest_api, insights_api, jobs, roi_api, status, versions_api  # noqa: E402


def create_app() -> FastAPI:
    app = FastAPI(title="Picture Sorter API")

    @app.exception_handler(db.DatabaseResetRequired)
    async def _db_reset(_: Request, exc: db.DatabaseResetRequired) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content={"error": "database_reset_required", "detail": str(exc)},
        )

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(cameras.router, prefix="/api")
    app.include_router(status.router, prefix="/api")
    app.include_router(versions_api.router, prefix="/api")
    app.include_router(ingest_api.router, prefix="/api")
    app.include_router(jobs.router, prefix="/api")
    app.include_router(frames_api.router, prefix="/api")
    app.include_router(roi_api.router, prefix="/api")
    app.include_router(classify_api.router, prefix="/api")
    app.include_router(insights_api.router, prefix="/api")
    return app


app = create_app()
