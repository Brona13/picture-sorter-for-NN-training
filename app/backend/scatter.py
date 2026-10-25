"""2D projections of ROI-cutout embeddings for the Dedup view's scatter plot.

Sanity-check surface only — the 2D coordinates distort real cosine distances.
Clustering decisions stay in full-dimensional space (see ``app/backend/dedup.py``).

Projections are cached in SQLite keyed by (camera, feature, method, backbone).
The cache is invalidated when the frame set signature changes.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

import db
import applog

_log = applog.get("scatter")


#: Called with the share done (0 to 1) while the layout is being optimised.
ProgressFn = Callable[[float], None]

_UMAP_EPOCH = re.compile(r"(\d+)/(\d+)")
_TSNE_ITER = re.compile(r"Iteration (\d+)")
TSNE_ITERATIONS = 1000  # scikit-learn's default number of optimisation steps


class _ProgressSink:
    """A file-like that turns the progress text of UMAP (tqdm epochs, "n/total") or t-SNE ("Iteration n") into a share done."""

    def __init__(self, kind: str, progress: ProgressFn) -> None:
        self.kind, self.progress = kind, progress

    def write(self, text: str) -> int:
        try:
            if self.kind == "umap":
                m = _UMAP_EPOCH.search(text)
                if m and int(m.group(2)) > 0:
                    self.progress(min(1.0, int(m.group(1)) / int(m.group(2))))
            else:
                m = _TSNE_ITER.search(text)
                if m:
                    self.progress(min(1.0, int(m.group(1)) / TSNE_ITERATIONS))
        except Exception:  # noqa: BLE001  (progress is a courtesy; it never breaks the projection)
            _log.debug("progress report failed", exc_info=True)
        return len(text)

    def flush(self) -> None:
        pass


DEFAULT_METHOD = "umap"
SUPPORTED_METHODS = ("umap", "tsne")


@dataclass
class Projection:
    method: str
    backbone: str
    frames: list[str]
    xy: np.ndarray  # (N, 2) float32
    from_cache: bool

    @property
    def coords(self) -> dict[str, tuple[float, float]]:
        return {f: (float(x), float(y)) for f, (x, y) in zip(self.frames, self.xy, strict=True)}


def frames_signature(frames: list[str]) -> str:
    """Stable fingerprint of the frame set the projection was fit on."""
    joined = ",".join(frames)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


def project(
    frames: list[str],
    matrix: np.ndarray,
    *,
    camera: str,
    feature: str,
    backbone: str,
    method: str = DEFAULT_METHOD,
    use_cache: bool = True,
    progress: ProgressFn | None = None,
) -> Projection:
    """Reduce ``matrix`` (N, D) to 2D using UMAP or t-SNE, with cache round-trip.

    ``frames`` are the row labels in the same order as ``matrix``. The frame-set
    signature is stored with the cache row so a changed set (ingest, delete,
    mute) invalidates the projection on read.

    Small frame sets (N < 4) skip projection and return zeros — projection is
    meaningless below that.
    """
    if method not in SUPPORTED_METHODS:
        raise ValueError(f"unsupported method {method!r}; use one of {SUPPORTED_METHODS}")

    n = matrix.shape[0]
    fsig = frames_signature(frames)

    if use_cache:
        cached = _load_cached(camera, feature, method, backbone, fsig)
        if cached is not None:
            return Projection(
                method=method, backbone=backbone, frames=frames,
                xy=cached, from_cache=True,
            )

    if use_cache and n >= 4:
        # Frames were removed (soft-deleted) since the cached layout: keep every
        # remaining point where it was instead of re-projecting and reshuffling the map.
        subset = _load_subset(camera, feature, method, backbone, frames)
        if subset is not None:
            _save_cached(camera, feature, method, backbone, fsig, frames, subset)
            return Projection(
                method=method, backbone=backbone, frames=frames, xy=subset, from_cache=True,
            )

    if n == 0:
        xy = np.zeros((0, 2), dtype=np.float32)
    elif n < 4:
        # Not enough points for either method to say anything useful; return a
        # flat row so the scatter still renders and the guard rails aren't hit.
        xy = np.zeros((n, 2), dtype=np.float32)
        xy[:, 0] = np.arange(n, dtype=np.float32)
    elif method == "umap":
        xy = _umap(matrix, progress)
    else:
        xy = _tsne(matrix, progress)

    if use_cache and n:
        _save_cached(camera, feature, method, backbone, fsig, frames, xy)

    return Projection(
        method=method, backbone=backbone, frames=frames, xy=xy, from_cache=False,
    )


# --- projections -------------------------------------------------------------
def _umap_baseline(matrix: np.ndarray) -> np.ndarray:
    """The pre-1.14 projection, kept so benchmark_scatter.py can compare against it."""
    import umap  # noqa: PLC0415  (optional dep, imported lazily)

    n = matrix.shape[0]
    # UMAP requires n_neighbors < n; clamp for small frame sets.
    n_neighbors = min(15, max(2, n - 1))
    reducer = umap.UMAP(
        n_components=2, n_neighbors=n_neighbors,
        metric="cosine", min_dist=0.1, random_state=42,
    )
    return reducer.fit_transform(matrix).astype(np.float32)


def _tsne(matrix: np.ndarray, progress: ProgressFn | None = None) -> np.ndarray:
    from sklearn.manifold import TSNE  # noqa: PLC0415

    n = matrix.shape[0]
    perplexity = min(30.0, max(2.0, (n - 1) / 3))
    tsne = TSNE(
        n_components=2, metric="cosine", perplexity=perplexity,
        init="pca", random_state=42, verbose=2 if progress else 0,
    )
    if progress is None:
        return tsne.fit_transform(matrix).astype(np.float32)
    with contextlib.redirect_stdout(_ProgressSink("tsne", progress)):  # its step messages are the progress
        xy = tsne.fit_transform(matrix).astype(np.float32)
    progress(1.0)  # it may stop before its last step when the error no longer improves
    return xy


EPOCHS_FULL_BELOW = 500  # below this many frames UMAP's own default (500 epochs) is cheap enough
EPOCHS_LARGE = 200


def _umap(matrix: np.ndarray, progress: ProgressFn | None = None) -> np.ndarray:
    """UMAP on PCA-50 unit vectors: NN-descent neighbours, multi-threaded, fewer layout epochs on larger sets.

    Measured in docs/scatter-performance.md: same layout quality (trustworthiness), up to ~10x faster.
    Not seeded: a fixed seed would force a single thread. The layout is cached per frame set anyway.
    """
    n = matrix.shape[0]
    epochs = None if n < EPOCHS_FULL_BELOW else EPOCHS_LARGE
    return _umap_with(matrix, pca=True, parallel=True, epochs=epochs, approx=True, progress=progress)


_warm_lock = threading.Lock()
_warm_started = False


def prewarm() -> None:
    """Import UMAP and compile its numba kernels in the background (once per process).

    The first projection of a process spends ~20 s importing and JIT-compiling; doing it while the user
    is still looking at the Dedup page or clustering makes the first "Compute projection" as fast as later ones.
    """
    global _warm_started  # noqa: PLW0603
    with _warm_lock:
        if _warm_started:
            return
        _warm_started = True

    def work() -> None:
        try:
            rng = np.random.default_rng(0)
            _umap(rng.normal(size=(120, 128)).astype(np.float32))
        except Exception:  # noqa: BLE001 - optional dependency missing: the real call reports it
            _log.debug("UMAP prewarm failed", exc_info=True)

    threading.Thread(target=work, name="scatter-prewarm", daemon=True).start()


# --- benchmark variants (see benchmark_scatter.py and docs/scatter-performance.md) ----
def _pca_unit(matrix: np.ndarray, dims: int = 50) -> np.ndarray:
    """PCA to ``dims`` components, rows re-normalised (cosine geometry survives)."""
    from sklearn.decomposition import PCA  # noqa: PLC0415

    n, d = matrix.shape
    if d <= dims or n <= dims:
        return matrix
    reduced = PCA(n_components=dims, svd_solver="randomized", random_state=42).fit_transform(matrix)
    norms = np.linalg.norm(reduced, axis=1, keepdims=True)
    return (reduced / np.maximum(norms, 1e-12)).astype(np.float32)


def _umap_with(
    matrix: np.ndarray, *, pca: bool, parallel: bool, epochs: int | None = None, approx: bool = False,
    progress: ProgressFn | None = None,
) -> np.ndarray:
    import umap  # noqa: PLC0415

    n = matrix.shape[0]
    data = _pca_unit(matrix) if pca else matrix
    kw: dict = {"n_components": 2, "n_neighbors": min(15, max(2, n - 1)), "min_dist": 0.1,
                "metric": "euclidean" if pca else "cosine"}
    if epochs:
        kw["n_epochs"] = epochs
    if approx:
        # Below 4096 points UMAP otherwise computes exact neighbours with one Python call per
        # pair (O(n^2) callbacks: ~8 s at 3000 points); NN-descent is parallel and near-exact.
        kw["force_approximation_algorithm"] = True
    if parallel:
        kw["n_jobs"] = -1  # a fixed random_state would force UMAP onto a single thread
    else:
        kw["random_state"] = 42
    if progress is None:
        return umap.UMAP(**kw).fit_transform(data).astype(np.float32)
    # The layout's epoch bar (tqdm) is written to a sink that reports the share done; the other verbose text is swallowed.
    sink = _ProgressSink("umap", progress)
    kw["verbose"] = True
    kw["tqdm_kwds"] = {"file": sink, "mininterval": 0.2, "bar_format": "{n}/{total}"}
    with contextlib.redirect_stdout(sink):
        xy = umap.UMAP(**kw).fit_transform(data).astype(np.float32)
    progress(1.0)
    return xy


def _tsne_with(matrix: np.ndarray, *, pca: bool, jobs: int | None) -> np.ndarray:
    from sklearn.manifold import TSNE  # noqa: PLC0415

    n = matrix.shape[0]
    data = _pca_unit(matrix) if pca else matrix
    return TSNE(
        n_components=2, metric="euclidean" if pca else "cosine",
        perplexity=min(30.0, max(2.0, (n - 1) / 3)), init="pca", random_state=42, n_jobs=jobs,
    ).fit_transform(data).astype(np.float32)


VARIANTS = {
    "umap": {
        "baseline": _umap_baseline,
        "parallel": lambda m: _umap_with(m, pca=False, parallel=True),
        "pca50": lambda m: _umap_with(m, pca=True, parallel=False),
        "pca50+parallel": lambda m: _umap_with(m, pca=True, parallel=True),
        "pca50+par+approx": lambda m: _umap_with(m, pca=True, parallel=True, approx=True),
        "pca50+par+approx+e200": lambda m: _umap_with(m, pca=True, parallel=True, approx=True, epochs=200),
        "pca50+par+e200": lambda m: _umap_with(m, pca=True, parallel=True, epochs=200),
        "pca50+par+e100": lambda m: _umap_with(m, pca=True, parallel=True, epochs=100),
    },
    "tsne": {
        "baseline": _tsne,
        "jobs": lambda m: _tsne_with(m, pca=False, jobs=-1),
        "pca50": lambda m: _tsne_with(m, pca=True, jobs=None),
        "pca50+jobs": lambda m: _tsne_with(m, pca=True, jobs=-1),
    },
}


# --- cache -------------------------------------------------------------------
def is_cached(camera: str, feature: str, method: str, backbone: str, frames: list[str]) -> bool:
    """Whether a projection for exactly these frames can be served from the cache without computing anything.

    True when every frame is part of the cached layout (the same set, or frames removed since), the two cases
    ``project`` answers from the cache.
    """
    return bool(frames) and _load_subset(camera, feature, method, backbone, frames) is not None


def _load_cached(
    camera: str, feature: str, method: str, backbone: str, fsig: str,
) -> np.ndarray | None:
    row = db.load_scatter(camera, feature, method, backbone)
    if row is None or row["frames_sig"] != fsig:
        return None
    try:
        data = json.loads(row["payload"].decode("utf-8"))
    except Exception:  # noqa: BLE001
        applog.warn_once(_log, "scatter-cache-payload", "unreadable scatter cache row, it is recomputed")
        return None
    xy = np.asarray(data.get("xy", []), dtype=np.float32)
    if xy.ndim != 2 or xy.shape[1] != 2:
        return None
    return xy


def _load_subset(
    camera: str, feature: str, method: str, backbone: str, frames: list[str],
) -> np.ndarray | None:
    """Cached coordinates for ``frames`` when they are all part of the cached layout."""
    row = db.load_scatter(camera, feature, method, backbone)
    if row is None:
        return None
    try:
        data = json.loads(row["payload"].decode("utf-8"))
        old_frames = list(data.get("frames", []))
        xy = np.asarray(data.get("xy", []), dtype=np.float32)
    except Exception:  # noqa: BLE001
        applog.warn_once(_log, "scatter-cache-previous", "unreadable previous scatter layout, starting fresh")
        return None
    if xy.ndim != 2 or xy.shape[1] != 2 or len(old_frames) != len(xy):
        return None
    index = {f: i for i, f in enumerate(old_frames)}
    if not frames or any(f not in index for f in frames):
        return None
    return xy[[index[f] for f in frames]]


def _save_cached(
    camera: str, feature: str, method: str, backbone: str,
    fsig: str, frames: list[str], xy: np.ndarray,
) -> None:
    payload = json.dumps(
        {"frames": list(frames), "xy": xy.tolist()},
    ).encode("utf-8")
    try:
        db.save_scatter(camera, feature, method, backbone, fsig, payload)
    except Exception:  # noqa: BLE001 - never let a cache miss break the view
        _log.warning("could not save the scatter cache for %s/%s", camera, feature, exc_info=True)
