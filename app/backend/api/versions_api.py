"""Versions: freeze / list / revert / export frozen snapshots of labels + goldens."""
from __future__ import annotations

import classify
import config
import datamodel
import db
import detections
import edge_angle
import engine
import labels
import motion
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


def _require_version(camera: str, feature: str, version_id: int, *, allow_deleted: bool = False) -> dict:
    """A version id must belong to this camera+feature, else reverting would apply
    another feature's snapshot. A deleted version has no snapshot left to use."""
    for v in versions.list_versions(camera, feature):
        if v["id"] == version_id:
            if v["deleted"] is not None and not allow_deleted:
                raise HTTPException(status_code=409, detail=f"Version {v['number']} was deleted")
            return v
    raise HTTPException(status_code=404, detail=f"No version {version_id} for {feature}")


def _cached_stats(camera: str, feature: str) -> dict:
    """Novelty stats from the persisted scored results (empty if never scored)."""
    roi_key = classify._roi_cache_key(engine.resolve_roi(camera, feature), camera, feature)
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
    recorded = versions.results_by_version(camera, feature)
    names = sorted({r["name"] for rs in recorded.values() for r in rs}, key=str.lower)
    return {
        "feature": feature,
        "classes": datamodel.classes_for(camera, feature),
        "counts": labels.counts(camera, feature),
        "versions": [{**v, "results": recorded.get(v["id"], [])} for v in versions.list_versions(camera, feature)],
        "result_names": names,
    }


class ResultBody(BaseModel):
    feature: str
    name: str
    value: float
    note: str = ""
    measured: str | None = None


def _result_error(exc: versions.ResultError) -> HTTPException:
    return HTTPException(status_code=404 if "no such" in str(exc) else 422, detail=str(exc))


@router.post("/cameras/{camera}/versions/{version_id}/results", status_code=201)
def add_result(camera: str, version_id: int, body: ResultBody) -> dict:
    """Record a value measured downstream on a dataset exported from this version."""
    require_feature(camera, body.feature)
    try:
        return versions.add_result(camera, body.feature, version_id, body.name, body.value, body.note, body.measured)
    except versions.ResultError as exc:
        raise _result_error(exc) from exc


@router.put("/cameras/{camera}/versions/{version_id}/results/{result_id}")
def update_result(camera: str, version_id: int, result_id: int, body: ResultBody) -> dict:
    require_feature(camera, body.feature)
    try:
        return versions.update_result(camera, body.feature, result_id, body.name, body.value, body.note, body.measured, version_id)
    except versions.ResultError as exc:
        raise _result_error(exc) from exc


@router.delete("/cameras/{camera}/versions/{version_id}/results/{result_id}")
def delete_result(camera: str, version_id: int, result_id: int, feature: str) -> dict:
    require_feature(camera, feature)
    try:
        versions.delete_result(camera, feature, result_id, version_id)
    except versions.ResultError as exc:
        raise _result_error(exc) from exc
    return {"deleted": result_id}


@router.post("/cameras/{camera}/versions", status_code=201)
def freeze(camera: str, body: FreezeRequest) -> dict:
    require_feature(camera, body.feature)
    stats = _cached_stats(camera, body.feature)
    vision = detections.vision_snapshot(camera, body.feature)
    if vision:
        stats["vision"] = vision  # frozen with the version so its vectors are reproducible
    rule = edge_angle.snapshot(camera, body.feature)
    if rule:
        stats["rules"] = {"edge_angle": rule}  # the rule-based opinion, as configured at freeze time
    augmentation = motion.snapshot(camera, body.feature)
    if augmentation:
        stats["augmentation"] = augmentation  # the chosen movement ranges; nothing is applied to images
    return versions.freeze(camera, body.feature, body.name, body.notes, stats=stats)


@router.post("/cameras/{camera}/versions/{version_id}/revert")
def revert(camera: str, version_id: int, feature: str) -> dict:
    require_feature(camera, feature)
    _require_version(camera, feature, version_id)
    return versions.revert(camera, feature, version_id)


@router.delete("/cameras/{camera}/versions/{version_id}")
def delete_version(camera: str, version_id: int, feature: str) -> dict:
    require_feature(camera, feature)
    _require_version(camera, feature, version_id, allow_deleted=True)
    try:
        versions.delete_version(camera, feature, version_id)
    except (versions.ActiveVersionError, versions.AlreadyDeletedError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"deleted": version_id}


@router.post("/cameras/{camera}/versions/{version_id}/export")
def export(camera: str, version_id: int, feature: str) -> dict:
    require_feature(camera, feature)
    _require_version(camera, feature, version_id)
    dest, report = versions.export(camera, feature, version_id)
    return {"destination": str(dest), **report}
