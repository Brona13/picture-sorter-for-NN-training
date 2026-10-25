"""FastAPI application factory.

Domain modules are imported flat (``import datamodel``); ``app/backend`` must be on
``sys.path`` (``conftest.py`` for tests, ``run.sh`` for the server). Paths come from
``config`` and are read at call time, so tests can point them at temp directories.
"""
from __future__ import annotations

import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402

import applog  # noqa: E402
import appinfo  # noqa: E402
import db  # noqa: E402
from api import cameras, chain_api, classify_api, config_api, dedup_api, flow_api, frames_api, ingest_api, insights_api, jobs, logs_api, motion_api, outliers_api, overview_api, roi_api, rules_api, similar_api, status, verdicts_api, versions_api, vision_api  # noqa: E402


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


SLOW_REQUEST_MS = 1000
_log = applog.get("http")


@asynccontextmanager
async def _lifespan(_: FastAPI):
    """Logging starts with the server, not at import, so tests never write into the real data directory."""
    directory = applog.setup()
    _log.info("started", extra=applog.audit(version=appinfo.VERSION, schema=db.SCHEMA_VERSION, log_dir=str(directory)))
    try:
        yield
    finally:
        _log.info("stopped", extra=applog.audit())
        applog.shutdown()


def _camera_of(path: str) -> str | None:
    parts = path.split("/")
    return parts[3] if len(parts) > 3 and parts[:3] == ["", "api", "cameras"] else None


def create_app() -> FastAPI:
    app = FastAPI(title="Picture Sorter API", lifespan=_lifespan)

    @app.middleware("http")
    async def _request_log(request: Request, call_next):
        """Give each request an id (echoed as ``X-Request-ID``) and log it; an unexpected error becomes a logged 500."""
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        tokens = (applog.request_id.set(rid), applog.camera.set(_camera_of(request.url.path)))
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
        except Exception as exc:  # noqa: BLE001 - last line of defence: log it and answer with a request id
            _log.exception("unhandled error in %s %s", request.method, request.url.path, extra=applog.fields(method=request.method, path=request.url.path))
            response = JSONResponse(status_code=500, content={"error": "internal_error", "detail": f"{type(exc).__name__}: {exc}", "request_id": rid})
        finally:
            ms = round((time.perf_counter() - started) * 1000, 1)
            level = 40 if status >= 500 else 30 if status >= 400 or ms >= SLOW_REQUEST_MS else 20 if request.method != "GET" else 10
            if request.url.path.startswith("/api") and request.url.path != "/api/logs":  # a report is not itself worth a line
                _log.log(level, "%s %s -> %s", request.method, request.url.path, status,
                         extra=applog.fields(method=request.method, path=request.url.path, status=status, duration_ms=ms))
            applog.request_id.reset(tokens[0])
            applog.camera.reset(tokens[1])
        response.headers["X-Request-ID"] = rid
        return response

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

    @app.get("/api/device")
    def device() -> dict[str, str]:
        import embedding  # noqa: PLC0415 - imports torch lazily on first use

        return embedding.device_info()

    app.include_router(cameras.router, prefix="/api")
    app.include_router(status.router, prefix="/api")
    app.include_router(overview_api.router, prefix="/api")
    app.include_router(verdicts_api.router, prefix="/api")
    app.include_router(versions_api.router, prefix="/api")
    app.include_router(ingest_api.router, prefix="/api")
    app.include_router(jobs.router, prefix="/api")
    app.include_router(logs_api.router, prefix="/api")
    app.include_router(frames_api.router, prefix="/api")
    app.include_router(roi_api.router, prefix="/api")
    app.include_router(chain_api.router, prefix="/api")
    app.include_router(flow_api.router, prefix="/api")
    app.include_router(classify_api.router, prefix="/api")
    app.include_router(insights_api.router, prefix="/api")
    app.include_router(dedup_api.router, prefix="/api")
    app.include_router(outliers_api.router, prefix="/api")
    app.include_router(similar_api.router, prefix="/api")
    app.include_router(rules_api.router, prefix="/api")
    app.include_router(motion_api.router, prefix="/api")
    app.include_router(vision_api.router, prefix="/api")
    app.include_router(config_api.router, prefix="/api")
    _mount_frontend(app)  # last: its catch-all must not shadow /api routes
    return app


app = create_app()
