"""Outlier scoring: how isolated each frame is in embedding space.

The score of a frame is its mean cosine distance to its ``k`` nearest other frames, computed
on the full embedding vectors (the same ones Dedup clusters, so the feature's filter and mask
apply). A high score means few similar frames: an unusual image worth a human look, or an
image that does not belong. It is an aid for review, not a verdict, and it is derived on
demand: nothing is stored.
"""
from __future__ import annotations

import numpy as np

import dedup

DEFAULT_K = 5
K_RANGE = (1, 20)
_CHUNK = 512


def knn_scores(matrix: np.ndarray, k: int = DEFAULT_K) -> np.ndarray:
    """Mean cosine distance of each row to its ``k`` nearest other rows (0 for a single row)."""
    n = matrix.shape[0]
    if n < 2:
        return np.zeros(n, dtype=np.float32)
    k = max(1, min(int(k), n - 1))
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    unit = matrix / np.where(norms == 0, 1.0, norms)
    out = np.empty(n, dtype=np.float32)
    for start in range(0, n, _CHUNK):
        stop = min(start + _CHUNK, n)
        sims = unit[start:stop] @ unit.T
        sims[np.arange(stop - start), np.arange(start, stop)] = -np.inf  # not its own neighbour
        nearest = -np.partition(-sims, k - 1, axis=1)[:, :k]
        out[start:stop] = 1.0 - nearest.mean(axis=1)
    return np.clip(out, 0.0, 2.0)


def rank(frames: list[str], scores: np.ndarray) -> list[tuple[str, float]]:
    """(frame, score) pairs, most isolated first; ties keep the original frame order."""
    order = sorted(range(len(frames)), key=lambda i: (-float(scores[i]), i))
    return [(frames[i], float(scores[i])) for i in order]


def summary(scores: np.ndarray) -> dict[str, float]:
    if scores.size == 0:
        return {"min": 0.0, "median": 0.0, "p95": 0.0, "max": 0.0}
    return {
        "min": float(scores.min()),
        "median": float(np.median(scores)),
        "p95": float(np.percentile(scores, 95)),
        "max": float(scores.max()),
    }


def compute(camera: str, feature: str, *, method: str, k: int = DEFAULT_K, progress_cb=None):
    """Score every live frame of the feature: ``(ranked [(frame, score)], summary)``."""
    kept, matrix = dedup.fetch_embeddings(camera, feature, dedup.live_frames(camera, feature), method, progress_cb)
    scores = knn_scores(matrix, k) if matrix.shape[0] else np.zeros(0, dtype=np.float32)
    return rank(kept, scores), summary(scores)
