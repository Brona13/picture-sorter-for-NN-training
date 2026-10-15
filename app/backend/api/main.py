"""FastAPI application factory.

Domain modules are imported flat (``import datamodel``); ``app/backend`` must be on
``sys.path`` (``conftest.py`` for tests, ``run.sh`` for the server). Paths come from
``config`` and are read at call time, so tests can point them at temp directories.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402

import appinfo  # noqa: E402
import db  # noqa: E402
from api import cameras, classify_api, dedup_api, frames_api, ingest_api, insights_api, jobs, overview_api, roi_api, status, versions_api, vision_api  # noqa: E402


def frontend_dist() -> Path:
    """Built React app (``npm run build``); override with ``CURATION_FRONTEND_DIST``."""
    default = _BACKEND_DIR.parent / "frontend" / "dist"
    return Path(os.environ.get("CURATION_FRONTEND_DIST", default))


def _mount_frontend(app: FastAPI) -> None:
    """Serve the built single-page app: real files as-is, any other non-API path -> index.html."""
    dist = frontend_dist().resolve()
    if not (dist / "index.html").is_file():
        return

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        target = (dist / path).resolve()
        if path and target.is_file() and dist in target.parents:
            return FileResponse(target)
        return FileResponse(dist / "index.html")


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

    @app.get("/api/version")
    def version() -> dict[str, str]:
        return {"version": appinfo.VERSION, "released": appinfo.RELEASED}

    app.include_router(cameras.router, prefix="/api")
    app.include_router(status.router, prefix="/api")
    app.include_router(overview_api.router, prefix="/api")
    app.include_router(versions_api.router, prefix="/api")
    app.include_router(ingest_api.router, prefix="/api")
    app.include_router(jobs.router, prefix="/api")
    app.include_router(frames_api.router, prefix="/api")
    app.include_router(roi_api.router, prefix="/api")
    app.include_router(classify_api.router, prefix="/api")
    app.include_router(insights_api.router, prefix="/api")
    app.include_router(dedup_api.router, prefix="/api")
    app.include_router(vision_api.router, prefix="/api")
    _mount_frontend(app)  # last: its catch-all must not shadow /api routes
    return app


app = create_app()
