"""Ingest endpoints: upload / folder import / rebuild catalog / create camera."""
from __future__ import annotations

import dataclasses
import re
import shutil
import tempfile
from pathlib import Path

import config
import datamodel
import ingest
import tags as camera_tags
from api import jobs
from api.cameras import require_camera
from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

router = APIRouter()


class FolderRequest(BaseModel):
    path: str


class CameraRequest(BaseModel):
    name: str
    tags: list[str] = []


def _ingest_job(camera: str, run, cleanup=None) -> dict:
    """Queue an ingest job. ``run(progress_cb)`` returns an ``IngestResult``."""

    def work(report):
        try:
            result = run(lambda p: report(dataclasses.asdict(p)))
        finally:
            if cleanup:
                cleanup()
        return {
            "added": result.n_added,
            "skipped": result.skipped,
            "errors": result.errors,
        }

    return jobs.registry.submit("ingest", camera, work).to_dict()


@router.post("/cameras", status_code=201)
def create_camera(body: CameraRequest) -> dict:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", body.name.strip()).strip("-.")
    if not name:
        raise HTTPException(status_code=422, detail="Enter a valid camera name.")
    try:
        cleaned = camera_tags.clean(body.tags)
    except camera_tags.TagError as e:
        raise HTTPException(status_code=422, detail=str(e))
    datamodel.ensure_camera_dirs(name)
    if cleaned:
        camera_tags.set_tags(name, cleaned)
    return {"name": name, "tags": cleaned}


@router.post("/cameras/{camera}/ingest/upload", status_code=202)
def upload(camera: str, files: list[UploadFile]) -> dict:
    require_camera(camera)
    if not files:
        raise HTTPException(status_code=422, detail="No files selected.")
    # The request's temp files vanish when it ends, so stage them for the job.
    staging = Path(tempfile.mkdtemp(prefix="picture-sorter-upload-"))
    items: list[tuple[str, Path]] = []
    rejected: list[str] = []
    try:
        for i, f in enumerate(files):
            name = Path(f.filename or "").name
            suffix = Path(name).suffix.lower()
            if suffix not in config.IMAGE_EXTENSIONS:
                rejected.append(f"{name or '(unnamed)'}: unsupported file type")
                continue
            staged = staging / f"{i:06d}{suffix}"
            with staged.open("wb") as out:
                shutil.copyfileobj(f.file, out, length=1024 * 1024)
            items.append((name, staged))
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    def run(cb):
        result = ingest.ingest_files(camera, items, progress_cb=cb, total=len(items))
        result.errors[:0] = rejected
        return result

    return _ingest_job(camera, run, cleanup=lambda: shutil.rmtree(staging, ignore_errors=True))


@router.post("/cameras/{camera}/ingest/folder", status_code=202)
def import_folder(camera: str, body: FolderRequest) -> dict:
    require_camera(camera)
    if not body.path.strip():
        raise HTTPException(status_code=422, detail="Enter a folder path.")
    return _ingest_job(
        camera, lambda cb: ingest.ingest_folder(camera, body.path.strip(), progress_cb=cb)
    )


@router.post("/cameras/{camera}/ingest/rebuild", status_code=202)
def rebuild(camera: str) -> dict:
    require_camera(camera)

    def work(report):
        return {"tracked": len(ingest.rebuild_index(camera))}

    return jobs.registry.submit("rebuild_index", camera, work).to_dict()
