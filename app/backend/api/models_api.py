"""Models: the datasets (frozen step-2 Exports with rectangles) a DS dataset collection can be built from, and the saved models that
pin them and are built into collection zips."""
from __future__ import annotations

import ds_export
import model_sets
import model_store
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

router = APIRouter()


def _call(fn, *args, **kwargs):
    """Run a model-store call; a refused request is 422 with its message, a missing model or build 404."""
    try:
        return fn(*args, **kwargs)
    except model_store.ModelNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (model_store.ModelError, ds_export.DsExportError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/models/datasets")
def list_datasets(size: str | None = None) -> dict:
    """Per camera, the step-2 freezes that hold rectangles, with their OK / NG counts and picture sizes. ``size=200x200`` lists only
    freezes whose pictures all have that size."""
    try:
        return model_sets.datasets(size)
    except model_sets.SizeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class DatasetBody(BaseModel):
    camera: str
    version_id: int
    folder_name: str | None = None  # default: the camera name
    ok_name: str | None = None  # default: <folder>-OK
    ng_name: str | None = None  # default: <folder>-NG
    ok_color: str | None = None
    ng_color: str | None = None


class CreateBody(BaseModel):
    name: str
    datasets: list[DatasetBody]
    include_without_box: bool = False


class UpdateBody(BaseModel):
    name: str | None = None
    datasets: list[DatasetBody] | None = None
    include_without_box: bool | None = None


class PreviewBody(BaseModel):
    datasets: list[DatasetBody]


def _raw(datasets: list[DatasetBody]) -> list[dict]:
    return [d.model_dump() for d in datasets]


@router.post("/models/preview")
def preview_classes(body: PreviewBody) -> dict:
    """The classes a collection of these datasets would have (equal names are one class) and notes, without reading any freeze."""
    return _call(model_store.preview, _raw(body.datasets))


@router.get("/models")
def list_models() -> dict:
    return {"models": model_store.list_models()}


@router.post("/models", status_code=201)
def create_model(body: CreateBody) -> dict:
    return _call(model_store.create_model, body.name, _raw(body.datasets), body.include_without_box)


@router.get("/models/{model_id}")
def get_model(model_id: int) -> dict:
    return _call(model_store.get_model, model_id)


@router.put("/models/{model_id}")
def update_model(model_id: int, body: UpdateBody) -> dict:
    return _call(
        model_store.update_model, model_id, body.name,
        None if body.datasets is None else _raw(body.datasets), body.include_without_box,
    )


@router.post("/models/{model_id}/build", status_code=201)
def build_model(model_id: int) -> dict:
    """Write the next collection zip of the model from its pinned freezes (it can take a while with many pictures)."""
    return _call(model_store.build, model_id)


@router.get("/models/{model_id}/builds")
def list_builds(model_id: int) -> dict:
    return {"builds": _call(model_store.builds, model_id)}


@router.get("/models/{model_id}/builds/{number}")
def get_build(model_id: int, number: int) -> dict:
    return _call(model_store.get_build, model_id, number)


@router.get("/models/{model_id}/builds/{number}/manifest")
def get_manifest(model_id: int, number: int, offset: int = 0, limit: int = 500) -> dict:
    """The pictures of a build (camera, freeze, dataset, DS name, original file, class, box), paged."""
    return _call(model_store.manifest, model_id, number, offset, limit)


@router.get("/models/{model_id}/builds/{number}/zip")
def download_zip(model_id: int, number: int) -> FileResponse:
    path = _call(model_store.zip_of, model_id, number)
    return FileResponse(path, media_type="application/zip", filename=path.name)
