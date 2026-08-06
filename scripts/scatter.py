"""2D projections of ROI-cutout embeddings for the Dedup view's scatter plot.

Sanity-check surface only — the 2D coordinates distort real cosine distances.
Clustering decisions stay in full-dimensional space (see ``scripts/dedup.py``).

Projections are cached in SQLite keyed by (camera, feature, method, backbone).
The cache is invalidated when the frame set signature changes.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

import numpy as np

import db


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

    if n == 0:
        xy = np.zeros((0, 2), dtype=np.float32)
    elif n < 4:
        # Not enough points for either method to say anything useful; return a
        # flat row so the scatter still renders and the guard rails aren't hit.
        xy = np.zeros((n, 2), dtype=np.float32)
        xy[:, 0] = np.arange(n, dtype=np.float32)
    elif method == "umap":
        xy = _umap(matrix)
    else:
        xy = _tsne(matrix)

    if use_cache and n:
        _save_cached(camera, feature, method, backbone, fsig, frames, xy)

    return Projection(
        method=method, backbone=backbone, frames=frames, xy=xy, from_cache=False,
    )


# --- projections -------------------------------------------------------------
def _umap(matrix: np.ndarray) -> np.ndarray:
    import umap  # noqa: PLC0415  (optional dep, imported lazily)

    n = matrix.shape[0]
    # UMAP requires n_neighbors < n; clamp for small frame sets.
    n_neighbors = min(15, max(2, n - 1))
    reducer = umap.UMAP(
        n_components=2, n_neighbors=n_neighbors,
        metric="cosine", min_dist=0.1, random_state=42,
    )
    return reducer.fit_transform(matrix).astype(np.float32)


def _tsne(matrix: np.ndarray) -> np.ndarray:
    from sklearn.manifold import TSNE  # noqa: PLC0415

    n = matrix.shape[0]
    perplexity = min(30.0, max(2.0, (n - 1) / 3))
    tsne = TSNE(
        n_components=2, metric="cosine", perplexity=perplexity,
        init="pca", random_state=42,
    )
    return tsne.fit_transform(matrix).astype(np.float32)


# --- cache -------------------------------------------------------------------
def _load_cached(
    camera: str, feature: str, method: str, backbone: str, fsig: str,
) -> np.ndarray | None:
    row = db.load_scatter(camera, feature, method, backbone)
    if row is None or row["frames_sig"] != fsig:
        return None
    try:
        data = json.loads(row["payload"].decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    xy = np.asarray(data.get("xy", []), dtype=np.float32)
    if xy.ndim != 2 or xy.shape[1] != 2:
        return None
    return xy


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
        pass
