"""Versions: freeze / list / revert / export frozen snapshots of labels + goldens."""
from __future__ import annotations

import classify
import config
import datamodel
import db
import engine
import labels
import versions
from api.cameras import require_camera, require_feature
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class FreezeRequest(BaseModel):
    feature: str
    name: str = ""
    notes: str = ""


def _selectable_features(camera: str, product: str | None) -> list[str]:
    return datamodel.list_features_for(camera, product) + [
        datamodel.compose_feature(product, config.WHOLE_FRAME_FEATURE)
    ]


def _require_version(camera: str, feature: str, version_id: int) -> dict:
    """A version id must belong to this camera+feature, else reverting would apply
    another feature's snapshot."""
    for v in versions.list_versions(camera, feature):
        if v["id"] == version_id:
            return v
    raise HTTPException(status_code=404, detail=f"No version {version_id} for {feature}")


def _cached_stats(camera: str, feature: str) -> dict:
    """Novelty stats from the persisted scored results (empty if never scored)."""
    roi_key = classify._roi_cache_key(engine.resolve_roi(camera, feature))
    row = db.load_results(camera, feature, roi_key)
    if row is None:
        return {}
    return classify.stats_for(classify.deserialise_results(row["payload"]))


@router.get("/cameras/{camera}/versions/features")
def selectable_features(camera: str, product: str | None = None) -> list[dict]:
    require_camera(camera)
    if product is not None and product not in datamodel.products(camera):
        raise HTTPException(status_code=404, detail=f"Unknown product: {product}")
    out = []
    for f in _selectable_features(camera, product):
        short = datamodel.split_feature(f)[1]
        shared = bool(product) and datamodel.split_feature(f)[0] is None
        out.append({"feature": f, "label": f"{short}  🔗 shared" if shared else short})
    return out


@router.get("/cameras/{camera}/versions")
def list_versions(camera: str, feature: str) -> dict:
    require_feature(camera, feature)
    return {
        "feature": feature,
        "classes": datamodel.classes_for(camera, feature),
        "counts": labels.counts(camera, feature),
        "versions": versions.list_versions(camera, feature),
    }


@router.post("/cameras/{camera}/versions", status_code=201)
def freeze(camera: str, body: FreezeRequest) -> dict:
    require_feature(camera, body.feature)
    return versions.freeze(
        camera, body.feature, body.name, body.notes, stats=_cached_stats(camera, body.feature)
    )


@router.post("/cameras/{camera}/versions/{version_id}/revert")
def revert(camera: str, version_id: int, feature: str) -> dict:
    require_feature(camera, feature)
    _require_version(camera, feature, version_id)
    return versions.revert(camera, feature, version_id)


@router.delete("/cameras/{camera}/versions/{version_id}")
def delete_version(camera: str, version_id: int, feature: str) -> dict:
    require_feature(camera, feature)
    _require_version(camera, feature, version_id)
    try:
        versions.delete_version(camera, feature, version_id)
    except versions.ActiveVersionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"deleted": version_id}


@router.post("/cameras/{camera}/versions/{version_id}/export")
def export(camera: str, version_id: int, feature: str) -> dict:
    require_feature(camera, feature)
    _require_version(camera, feature, version_id)
    dest, report = versions.export(camera, feature, version_id)
    return {"destination": str(dest), **report}
