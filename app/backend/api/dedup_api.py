"""Dedup: DBSCAN near-duplicate clustering, scatter projection, apply/clear mutes.

The last clustering per (camera, feature) is kept in process memory (embeddings are
large and cheap to recompute from the persistent vector cache); Apply needs it, and a
server restart simply means "run Cluster again".
"""
from __future__ import annotations

import dataclasses
import threading

import datamodel
import db
import dedup
import embedding
import labels
import scatter
from api import jobs
from api.cameras import require_feature
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

EPSILON_RANGE = (0.001, 0.20)
MIN_POINTS_RANGE = (2, 10)
DEFAULT_EPSILON = 0.02
DEFAULT_MIN_POINTS = 2

_lock = threading.Lock()
_results: dict[tuple[str, str], dedup.ClusterResult] = {}


def _sklearn_available() -> bool:
    try:
        from sklearn.cluster import DBSCAN  # noqa: F401, PLC0415
    except Exception:  # noqa: BLE001
        return False
    return True


def _setting(camera: str, feature: str, name: str, cast, default):
    raw = db.get_setting(camera, f"dedup.{name}.{feature}")
    if raw is None:
        return default
    try:
        return cast(raw)
    except (TypeError, ValueError):
        return default


def _saved_params(camera: str, feature: str, backbones: list[str]) -> dict:
    method = _setting(camera, feature, "method", str, dedup.DEFAULT_BACKBONE)
    if method not in backbones:
        method = dedup.DEFAULT_BACKBONE if dedup.DEFAULT_BACKBONE in backbones else (backbones[0] if backbones else "")
    return {
        "method": method,
        "epsilon": _setting(camera, feature, "epsilon", float, DEFAULT_EPSILON),
        "min_points": _setting(camera, feature, "min_points", int, DEFAULT_MIN_POINTS),
    }


def _availability() -> str | None:
    if not embedding.backbones():
        return "no_embeddings"
    if not _sklearn_available():
        return "no_sklearn"
    return None


def _require_available() -> None:
    reason = _availability()
    if reason:
        raise HTTPException(status_code=409, detail=f"Dedup unavailable: {reason}")


def _describe(result: dedup.ClusterResult) -> dict:
    return {
        "params": {"method": result.method, "epsilon": result.epsilon, "min_points": result.min_points},
        "summary": dedup.summary(result),
        "would_mute": len(result.muted_from_representatives()),
        "clusters": [
            {"id": cid, "members": result.members(cid), "representative": result.representatives[cid]}
            for cid in result.clusters
        ],
        "noise_frames": result.noise_frames,
    }


class Params(BaseModel):
    feature: str
    method: str
    epsilon: float
    min_points: int


def _validate(camera: str, p: Params) -> None:
    require_feature(camera, p.feature)
    if p.method not in embedding.backbones():
        raise HTTPException(status_code=422, detail=f"Unknown embedding: {p.method}")
    if not EPSILON_RANGE[0] <= p.epsilon <= EPSILON_RANGE[1]:
        raise HTTPException(status_code=422, detail="epsilon is out of range.")
    if not MIN_POINTS_RANGE[0] <= p.min_points <= MIN_POINTS_RANGE[1]:
        raise HTTPException(status_code=422, detail="min_points is out of range.")


@router.get("/cameras/{camera}/dedup/state")
def state(camera: str, feature: str) -> dict:
    require_feature(camera, feature)
    backbones = embedding.backbones()
    with _lock:
        result = _results.get((camera, feature))
    return {
        "feature": feature,
        "reason": _availability(),
        "backbones": backbones,
        "params": _saved_params(camera, feature, backbones),
        "ranges": {"epsilon": EPSILON_RANGE, "min_points": MIN_POINTS_RANGE},
        "frames": len(datamodel.frames_for_feature(camera, feature)),
        "device": embedding.active_device(),
        "muted_count": len(db.muted_frames(camera, feature)),
        "projections": list(scatter.SUPPORTED_METHODS),
        "result": _describe(result) if result else None,
    }


@router.put("/cameras/{camera}/dedup/settings")
def save_settings(camera: str, body: Params) -> dict:
    _validate(camera, body)
    for name, value in (("method", body.method), ("epsilon", round(body.epsilon, 6)), ("min_points", body.min_points)):
        db.set_setting(camera, f"dedup.{name}.{body.feature}", str(value))
    return {"params": _saved_params(camera, body.feature, embedding.backbones())}


@router.post("/cameras/{camera}/dedup/cluster", status_code=202)
def run_cluster(camera: str, body: Params) -> dict:
    _require_available()
    _validate(camera, body)
    if not datamodel.frames_for_feature(camera, body.feature):
        raise HTTPException(status_code=409, detail="This feature has no frames yet — ingest some first.")

    def work(report):
        def progress(done: int, total: int) -> None:
            report({"phase": "embedding", "done": done, "total": total})

        result = dedup.cluster(
            camera, body.feature, epsilon=body.epsilon, min_points=body.min_points,
            method=body.method, progress_cb=progress,
        )
        with _lock:
            _results[(camera, body.feature)] = result
        return _describe(result)

    return jobs.registry.submit("dedup_cluster", camera, work, feature=body.feature).to_dict()


class ApplyBody(BaseModel):
    feature: str
    picks: dict[int, str] = {}


@router.post("/cameras/{camera}/dedup/apply")
def apply(camera: str, body: ApplyBody) -> dict:
    require_feature(camera, body.feature)
    with _lock:
        result = _results.get((camera, body.feature))
    if result is None:
        raise HTTPException(status_code=409, detail="Run Cluster first.")
    for cid, frame in body.picks.items():
        if cid not in result.clusters or frame not in result.members(cid):
            raise HTTPException(status_code=422, detail=f"Frame {frame!r} is not a member of cluster {cid}.")
    report = dedup.apply(camera, body.feature, result, body.picks)
    with _lock:
        _results.pop((camera, body.feature), None)
    return dataclasses.asdict(report)


@router.delete("/cameras/{camera}/dedup/mutes")
def clear_mutes(camera: str, feature: str) -> dict:
    require_feature(camera, feature)
    return {"unmuted": db.clear_dedup_mutes(camera, feature)}


class ScatterBody(BaseModel):
    feature: str
    projection: str = scatter.DEFAULT_METHOD


@router.post("/cameras/{camera}/dedup/scatter", status_code=202)
def run_scatter(camera: str, body: ScatterBody) -> dict:
    """2D projection of the last clustering (job: UMAP/t-SNE can be slow on first use)."""
    require_feature(camera, body.feature)
    if body.projection not in scatter.SUPPORTED_METHODS:
        raise HTTPException(status_code=422, detail=f"Unknown projection: {body.projection}")
    with _lock:
        result = _results.get((camera, body.feature))
    if result is None:
        raise HTTPException(status_code=409, detail="Run Cluster first.")
    if result.embeddings.shape[0] < 2:
        raise HTTPException(status_code=409, detail="Not enough frames to project.")

    def work(report):
        report({"phase": "projecting", "done": 0, "total": 1})
        try:
            proj = scatter.project(
                result.frame_order, result.embeddings, camera=camera, feature=body.feature,
                backbone=result.method, method=body.projection,
            )
        except ImportError as exc:
            raise RuntimeError(
                "umap-learn (or scikit-learn for t-SNE) isn't installed — "
                "pip install -r requirements-embedding.txt enables the scatter."
            ) from exc
        gold = labels.current_goldens(camera, body.feature)
        golden_of = {f: cls for cls, frames in gold.items() for f in frames}
        reps = set(result.representatives.values())
        coords = proj.coords
        points = [
            {
                "frame": f,
                "x": coords[f][0],
                "y": coords[f][1],
                "cluster": result.labels_by_frame.get(f, dedup.NOISE),
                "representative": f in reps,
                "golden": golden_of.get(f),
            }
            for f in proj.frames
        ]
        return {"projection": body.projection, "from_cache": proj.from_cache, "points": points,
                "classes": datamodel.classes_for(camera, body.feature)}

    return jobs.registry.submit("dedup_scatter", camera, work, feature=body.feature).to_dict()
