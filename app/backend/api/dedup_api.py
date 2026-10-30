"""Dedup: DBSCAN near-duplicate clustering, scatter projection, apply/clear mutes.

The last clustering per (camera, feature) is kept in process memory (embeddings are
large and cheap to recompute from the persistent vector cache); Apply needs it, and a
server restart simply means "run Cluster again".
"""
from __future__ import annotations

import grid_sizes
import dataclasses
import threading

import anchor
import datamodel
import db
import dedup
import dedup_box
import flow
import embedding
import methods_config
import labels
import scatter
import vision_settings
from api import jobs
from api.cameras import require_camera
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import applog

_log = applog.get("dedup_api")

router = APIRouter()

EPSILON_RANGE = (0.001, 0.20)
MIN_POINTS_RANGE = (2, 10)
DEFAULT_EPSILON = 0.02
DEFAULT_MIN_POINTS = 2
PER_PAGE_OPTIONS = grid_sizes.all_per_page()  # alone (no column count): any size that is valid for some column count
COLS_OPTIONS = list(grid_sizes.COLS)

def require_box(camera: str, feature: str) -> str:
    """Dedup works on Dedup boxes of the Chain (``dedup:N``)."""
    require_camera(camera)
    if not dedup_box.exists(camera, feature):
        raise HTTPException(status_code=404, detail=f"Unknown Dedup box: {feature}")
    return feature


def require_embeddable(camera: str, feature: str) -> str:
    """A Dedup box, or a Classifier (ROI) by name: the Classify page's Scatter and Outliers views work on the Classifier itself."""
    require_camera(camera)
    if not dedup_box.exists(camera, feature) and (dedup_box.is_box(feature) or datamodel.get_roi(camera, feature) is None):
        raise HTTPException(status_code=404, detail=f"Unknown Dedup box or Classifier: {feature}")
    return feature


@router.get("/cameras/{camera}/dedup/boxes")
def list_boxes(camera: str) -> list[dict]:
    """The Dedup boxes of the Chain, for the page's box picker."""
    require_camera(camera)
    import chain  # noqa: PLC0415

    stored = chain.load_layout(camera)["nodes"]
    return [{"feature": b, "label": stored.get(b, {}).get("label") or f"Dedup {b.split(':')[1]}"} for b in dedup_box.boxes(camera)]


_lock = threading.Lock()
_results: dict[tuple[str, str], dedup.ClusterResult] = {}
_epochs: dict[tuple[str, str], int] = {}  # vision_settings.epoch() when the result was computed
_sweeps: dict[tuple[str, str], dict] = {}  # the last sweep chart per (camera, feature), with the epoch it was computed at
SWEEP_MAX_EPSILONS = 400
SWEEP_MAX_RUNS = 1500


def _current_result(camera: str, feature: str) -> dedup.ClusterResult | None:
    """The held clustering, unless filter/mask/detection settings changed since it was computed.

    Its embeddings (and any projection built from them) would describe the old crops.
    """
    key = (camera, feature)
    with _lock:
        result = _results.get(key)
        if result is not None and _epochs.get(key) != vision_settings.epoch():
            _results.pop(key, None)
            return None
        return result


def drop_deleted(camera: str, frames: list[str]) -> None:
    """Soft-deleted frames leave the clustering held in memory: re-cluster the rest."""
    removed = set(frames)
    with _lock:
        for key in [k for k in _results if k[0] == camera]:
            try:
                _results[key] = dedup.recluster_without(_results[key], removed)
            except Exception:  # noqa: BLE001 - worst case the user clusters again
                _log.warning("could not update the held clustering %s, it is dropped", key, exc_info=True)
                _results.pop(key, None)


def _sklearn_available() -> bool:
    try:
        with applog.timed("dedup.import_sklearn"):  # the first import after a start takes seconds on a slow disk
            from sklearn.cluster import DBSCAN  # noqa: F401, PLC0415
    except Exception:  # noqa: BLE001
        _log.info("scikit-learn is not available", exc_info=True)
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
    with applog.timed("dedup.embedding_backbones"):  # waits for the PyTorch load when it is still running
        found = embedding.backbones()
    if not found:
        return "no_embeddings"
    if not methods_config.active_backbones():
        return "methods_off"
    if not _sklearn_available():
        return "no_sklearn"
    return None


def _require_available() -> None:
    reason = _availability()
    if reason:
        raise HTTPException(status_code=409, detail=f"Dedup unavailable: {reason}")


def marks_for(camera: str, feature: str, frames: list[str]) -> dict[str, dict]:
    """Label and golden marks of the labeled/golden frames among ``frames``."""
    source = dedup_box.label_source(camera, feature)  # a Dedup box shows the labels of the Classifier it reads
    lab = labels.current_labels(camera, source)
    gold = labels.current_goldens(camera, source)
    golden_of = {f: cls for cls, frames_ in gold.items() for f in frames_}
    return {f: {"label": lab.get(f), "golden": golden_of.get(f)} for f in frames if f in lab or f in golden_of}


def _describe(camera: str, feature: str, result: dedup.ClusterResult) -> dict:
    marks = marks_for(camera, feature, result.frame_order)
    return {
        "params": {"method": result.method, "epsilon": result.epsilon, "min_points": result.min_points},
        "summary": dedup.summary(result),
        "would_mute": len(result.muted_from_representatives()),
        "clusters": [
            {"id": cid, "members": result.members(cid), "representative": result.representatives[cid]}
            for cid in result.clusters
        ],
        "noise_frames": result.noise_frames,
        "classes": datamodel.classes_for(camera, dedup_box.label_source(camera, feature)),
        "marks": marks,
    }


def _grid_settings(camera: str, feature: str) -> dict:
    def pick(kind: str, options: list[int], default: int) -> int:
        try:
            value = int(db.get_setting(camera, f"dedup.grid.{kind}.{feature}") or default)
        except (TypeError, ValueError):
            value = default
        return value if value in options else default

    return {
        "per_page": pick("perpage", PER_PAGE_OPTIONS, 24),
        "cols": pick("cols", COLS_OPTIONS, 4),
        "per_page_options": grid_sizes.per_page_options(pick("cols", COLS_OPTIONS, 4)),
        "cols_options": COLS_OPTIONS,
    }


class Params(BaseModel):
    feature: str
    method: str
    epsilon: float
    min_points: int


def _validate(camera: str, p: Params) -> None:
    require_embeddable(camera, p.feature)
    if p.method not in methods_config.active_backbones():
        raise HTTPException(status_code=422, detail=f"Embedding not available (switched off in Configuration?): {p.method}")
    if not EPSILON_RANGE[0] <= p.epsilon <= EPSILON_RANGE[1]:
        raise HTTPException(status_code=422, detail="epsilon is out of range.")
    if not MIN_POINTS_RANGE[0] <= p.min_points <= MIN_POINTS_RANGE[1]:
        raise HTTPException(status_code=422, detail="min_points is out of range.")


@router.get("/cameras/{camera}/dedup/state")
def state(camera: str, feature: str) -> dict:
    with applog.timed("dedup.state.require"):
        require_embeddable(camera, feature)
    with applog.timed("dedup.state.prewarm"):
        scatter.prewarm()  # UMAP's first use imports and compiles for ~20 s: do it while the user is on this page
    with applog.timed("dedup.state.backbones"):
        backbones = methods_config.active_backbones()
    with applog.timed("dedup.state.result"):
        result = _current_result(camera, feature)
    with applog.timed("dedup.state.source"):
        source = dedup_box.label_source(camera, feature)  # the feature the picture actions (label, delete) go through
    with applog.timed("dedup.state.availability"):
        reason = _availability()
    with applog.timed("dedup.state.params"):
        params = _saved_params(camera, feature, backbones)
    with applog.timed("dedup.state.frames"):
        frames = len(dedup.live_frames(camera, feature))
    with applog.timed("dedup.state.device"):  # imports PyTorch if it is not loaded yet
        device, device_label = embedding.active_device(), embedding.device_label()
    with applog.timed("dedup.state.muted"):
        muted = len(db.muted_frames(camera, feature))
    with applog.timed("dedup.state.describe"):
        described = _describe(camera, feature, result) if result else None
    with applog.timed("dedup.state.grid"):
        grid = _grid_settings(camera, feature)
    return {
        "feature": feature,
        "source": source,
        "reason": reason,
        "backbones": backbones,
        "params": params,
        "ranges": {"epsilon": EPSILON_RANGE, "min_points": MIN_POINTS_RANGE},
        "frames": frames,
        "device": device,
        "device_label": device_label,
        "muted_count": muted,
        "projections": list(scatter.SUPPORTED_METHODS),
        "result": described,
        "grid": grid,
    }


@router.get("/cameras/{camera}/dedup/frames")
def box_frames(camera: str, feature: str) -> dict:
    """The pictures a Dedup box sees (for its Grid), which of them it muted, and the labels of the Classifier it reads."""
    require_box(camera, feature)
    frames = dedup.live_frames(camera, feature)
    spec = anchor.get_anchor(camera, feature)
    if spec:  # a box fed by one target of a detector shows that target's box: a picture with none has no card
        source = anchor.Source(camera, spec)
        hashes = labels.hash_map(camera)
        frames = [f for f in frames if source.entry(hashes.get(f, "")) is not None]
    own = db.muted_frames(camera, feature)
    return {
        "frames": frames,
        "muted": [f for f in frames if f in own],
        "source": dedup_box.label_source(camera, feature),
        "classes": datamodel.classes_for(camera, dedup_box.label_source(camera, feature)),
        "marks": marks_for(camera, feature, frames),
    }


@router.put("/cameras/{camera}/dedup/settings")
def save_settings(camera: str, body: Params) -> dict:
    _validate(camera, body)
    for name, value in (("method", body.method), ("epsilon", round(body.epsilon, 6)), ("min_points", body.min_points)):
        db.set_setting(camera, f"dedup.{name}.{body.feature}", str(value))
    return {"params": _saved_params(camera, body.feature, methods_config.active_backbones())}


class GridSettings(BaseModel):
    feature: str
    per_page: int
    cols: int


@router.put("/cameras/{camera}/dedup/grid-settings")
def save_grid_settings(camera: str, body: GridSettings) -> dict:
    """Per-ROI grid size of the cluster browser (kept apart from Classify's)."""
    require_box(camera, body.feature)
    if not grid_sizes.is_valid(body.per_page, body.cols):
        raise HTTPException(status_code=422, detail="Unsupported per_page or cols value.")
    db.set_setting(camera, f"dedup.grid.perpage.{body.feature}", str(body.per_page))
    db.set_setting(camera, f"dedup.grid.cols.{body.feature}", str(body.cols))
    return _grid_settings(camera, body.feature)


@router.post("/cameras/{camera}/dedup/cluster", status_code=202)
def run_cluster(camera: str, body: Params) -> dict:
    _require_available()
    _validate(camera, body)
    if not dedup.live_frames(camera, body.feature):
        raise HTTPException(status_code=409, detail="This Dedup box has no pictures yet: ingest some, or label some for the Classifier it reads.")

    def work(report):
        epoch = vision_settings.epoch()  # taken before computing: a change mid-run marks it stale

        def progress(done: int, total: int) -> None:
            report({"phase": "embedding", "done": done, "total": total})

        result = dedup.cluster(
            camera, body.feature, epsilon=body.epsilon, min_points=body.min_points,
            method=body.method, progress_cb=progress,
        )
        with _lock:
            _results[(camera, body.feature)] = result
            _epochs[(camera, body.feature)] = epoch
        return _describe(camera, body.feature, result)

    return jobs.registry.submit("dedup_cluster", camera, work, feature=body.feature).to_dict()


class SweepBody(BaseModel):
    feature: str
    method: str
    eps_from: float
    eps_to: float
    eps_step: float
    mp_from: int
    mp_to: int


def _sweep_grid(body: SweepBody) -> tuple[list[float], list[int]]:
    lo, hi = EPSILON_RANGE
    if not (lo <= body.eps_from <= hi and lo <= body.eps_to <= hi):
        raise HTTPException(status_code=422, detail=f"Epsilon must be between {lo} and {hi}.")
    if body.eps_to <= body.eps_from:
        raise HTTPException(status_code=422, detail="Epsilon 'to' must be larger than 'from'.")
    if body.eps_step < 0.0001:
        raise HTTPException(status_code=422, detail="Epsilon step is too small (minimum 0.0001).")
    if not (MIN_POINTS_RANGE[0] <= body.mp_from <= body.mp_to <= MIN_POINTS_RANGE[1]):
        raise HTTPException(status_code=422, detail=f"Min points must be between {MIN_POINTS_RANGE[0]} and {MIN_POINTS_RANGE[1]}, 'from' not above 'to'.")
    epsilons = dedup.sweep_epsilons(body.eps_from, body.eps_to, body.eps_step)
    mps = list(range(body.mp_from, body.mp_to + 1))
    if len(epsilons) > SWEEP_MAX_EPSILONS:
        raise HTTPException(status_code=422, detail=f"{len(epsilons)} Epsilon values is too many (maximum {SWEEP_MAX_EPSILONS}): widen the step.")
    if len(epsilons) * len(mps) > SWEEP_MAX_RUNS:
        raise HTTPException(status_code=422, detail=f"{len(epsilons) * len(mps)} runs is too many (maximum {SWEEP_MAX_RUNS}): widen the step or lower the Min points range.")
    return epsilons, mps


@router.post("/cameras/{camera}/dedup/sweep", status_code=202)
def run_sweep(camera: str, body: SweepBody) -> dict:
    """Cluster over a range of Epsilon x Min points and hand back cluster / would-mute counts for the chart."""
    _require_available()
    _validate(camera, Params(feature=body.feature, method=body.method, epsilon=body.eps_from, min_points=body.mp_from))
    epsilons, mps = _sweep_grid(body)
    if not dedup.live_frames(camera, body.feature):
        raise HTTPException(status_code=409, detail="This Dedup box has no pictures yet: ingest some, or label some for the Classifier it reads.")

    def work(report):
        epoch = vision_settings.epoch()

        def embedding_progress(done: int, total: int) -> None:
            report({"phase": "embedding", "done": done, "total": total})

        def progress(done: int, total: int) -> None:
            report({"phase": "sweep", "done": done, "total": total})

        out = dedup.sweep(
            camera, body.feature, method=body.method, epsilons=epsilons, min_points=mps,
            embedding_progress=embedding_progress, progress_cb=progress,
        )
        out = _sweep_json(out)
        with _lock:
            _sweeps[(camera, body.feature)] = {"epoch": epoch, "sweep": out}
        return out

    return jobs.registry.submit("dedup_sweep", camera, work, feature=body.feature).to_dict()


def _sweep_json(out: dict) -> dict:
    """JSON-friendly sweep: the lines as a list (JSON objects have string keys, a list keeps Min points numeric)."""
    return {**out, "lines": [{"min_points": mp, **out["lines"][mp]} for mp in out["min_points"]]}


@router.get("/cameras/{camera}/dedup/sweep")
def get_sweep(camera: str, feature: str) -> dict:
    """The last sweep chart of this box, or ``{"sweep": null}`` when there is none or the settings changed since."""
    require_embeddable(camera, feature)
    with _lock:
        held = _sweeps.get((camera, feature))
        if held is not None and held["epoch"] != vision_settings.epoch():
            _sweeps.pop((camera, feature), None)
            held = None
    return {"sweep": None if held is None else held["sweep"]}


class MuteBody(BaseModel):
    feature: str
    frames: list[str]


@router.post("/cameras/{camera}/dedup/mute-frames")
def mute_frames(camera: str, body: MuteBody) -> dict:
    """Mute these pictures in the box (the Scatter selection's Mute button). Clusters held for the box stay as they are."""
    require_box(camera, body.feature)
    if not body.frames:
        raise HTTPException(status_code=422, detail="No frames to mute.")
    return dedup.mute_frames(camera, body.feature, body.frames)


class ApplyBody(BaseModel):
    feature: str
    picks: dict[int, str] = {}


@router.post("/cameras/{camera}/dedup/apply")
def apply(camera: str, body: ApplyBody) -> dict:
    require_box(camera, body.feature)
    result = _current_result(camera, body.feature)
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
    require_box(camera, feature)
    return {"unmuted": db.clear_dedup_mutes(camera, feature)}


class ScatterBody(BaseModel):
    feature: str
    projection: str = scatter.DEFAULT_METHOD
    #: Embedding to project; defaults to the one of the held clustering. No clustering is needed.
    method: str | None = None


@router.get("/cameras/{camera}/dedup/scatter/cached")
def scatter_cached(camera: str, feature: str, projection: str, method: str) -> dict:
    """Whether the 2D map for this embedding and projection can be shown at once (nothing to compute)."""
    require_embeddable(camera, feature)
    if projection not in scatter.SUPPORTED_METHODS:
        raise HTTPException(status_code=422, detail=f"Unknown projection: {projection}")
    return {"cached": scatter.is_cached(camera, feature, projection, method, dedup.live_frames(camera, feature))}


@router.post("/cameras/{camera}/dedup/scatter", status_code=202)
def run_scatter(camera: str, body: ScatterBody) -> dict:
    """2D projection of the feature's embeddings (job: UMAP/t-SNE can be slow on first use).

    Points carry the current label and golden, and the cluster of the held clustering when there is
    one for the same embedding, so the page can colour by any of them.
    """
    require_embeddable(camera, body.feature)
    if body.projection not in scatter.SUPPORTED_METHODS:
        raise HTTPException(status_code=422, detail=f"Unknown projection: {body.projection}")
    held = _current_result(camera, body.feature)
    method = body.method or (held.method if held else None)
    if not method:
        raise HTTPException(status_code=422, detail="Choose an embedding to project.")
    if method not in methods_config.active_backbones():
        raise HTTPException(status_code=422, detail=f"Embedding not available (switched off in Configuration?): {method}")
    if len(dedup.live_frames(camera, body.feature)) < 2:
        raise HTTPException(status_code=409, detail="Not enough frames to project.")
    result = held if held is not None and held.method == method else None

    def work(report):
        report({"phase": "projecting", "done": 0, "total": 1000})
        if result is not None:
            frame_order, matrix = result.frame_order, result.embeddings
        else:
            def progress(done: int, total: int) -> None:
                report({"phase": "embedding", "done": done, "total": total})

            frame_order, matrix = dedup.fetch_embeddings(camera, body.feature, dedup.live_frames(camera, body.feature), method, progress)
        if matrix.shape[0] < 2:
            raise RuntimeError("Not enough frames to project.")
        try:
            def layout_progress(share: float) -> None:
                report({"phase": "projecting", "done": int(share * 1000), "total": 1000})

            proj = scatter.project(
                frame_order, matrix, camera=camera, feature=body.feature,
                backbone=method, method=body.projection, progress=layout_progress,
            )
        except ImportError as exc:
            raise RuntimeError(
                "umap-learn (or scikit-learn for t-SNE) isn't installed — "
                "pip install -r requirements-embedding.txt enables the scatter."
            ) from exc
        source = dedup_box.label_source(camera, body.feature)
        gold = labels.current_goldens(camera, source)
        golden_of = {f: cls for cls, frames in gold.items() for f in frames}
        label_of = labels.current_labels(camera, source)
        reps = set(result.representatives.values()) if result else set()
        coords = proj.coords
        points = [
            {
                "frame": f,
                "x": coords[f][0],
                "y": coords[f][1],
                "cluster": result.labels_by_frame.get(f, dedup.NOISE) if result else None,
                "representative": f in reps,
                "golden": golden_of.get(f),
                "label": label_of.get(f),
            }
            for f in proj.frames
        ]
        return {"projection": body.projection, "method": method, "from_cache": proj.from_cache, "points": points,
                "classes": datamodel.classes_for(camera, dedup_box.label_source(camera, body.feature))}

    return jobs.registry.submit("dedup_scatter", camera, work, feature=body.feature).to_dict()
