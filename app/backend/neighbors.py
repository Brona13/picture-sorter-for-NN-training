"""Nearest-neighbour retrieval for batch labeling: frames most similar to a labeled seed.

Given a labeled seed frame, rank the *unlabeled* frames of the same feature by cosine distance to
the seed in embedding space (the same vectors Dedup and outlier scoring use, so the feature's
filter and mask apply). The human then confirms or rejects the matches as a batch. Nothing here
writes a label: applying the seed's label goes through :func:`apply_label`, which re-checks that
each frame is still live and unlabeled, so a stale list can never overwrite a human decision.
"""
from __future__ import annotations

import numpy as np

import dedup
import labels

DEFAULT_LIMIT = 60
LIMIT_RANGE = (1, 500)


def distances_to(matrix: np.ndarray, seed_index: int) -> np.ndarray:
    """Cosine distance of every row to row ``seed_index`` (0 = identical direction)."""
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    unit = matrix / np.where(norms == 0, 1.0, norms)
    return np.clip(1.0 - unit @ unit[seed_index], 0.0, 2.0)


def rank_candidates(
    frames: list[str], matrix: np.ndarray, seed: str, candidates: set[str], limit: int,
) -> list[tuple[str, float]]:
    """``candidates`` ordered nearest-first to ``seed`` (ties keep frame order), at most ``limit``."""
    if seed not in frames:
        return []
    dist = distances_to(matrix, frames.index(seed))
    order = sorted((i for i, f in enumerate(frames) if f in candidates and f != seed), key=lambda i: (float(dist[i]), i))
    return [(frames[i], float(dist[i])) for i in order[:limit]]


def candidate_frames(camera: str, feature: str, muted: set[str]) -> tuple[list[str], set[str]]:
    """(live frames shown in Classify, those among them that are still unlabeled)."""
    live = [f for f in dedup.live_frames(camera, feature) if f not in muted]
    lab = labels.current_labels(camera, feature)
    return live, {f for f in live if f not in lab}


def find_similar(
    camera: str, feature: str, seed: str, *, method: str, muted: set[str],
    limit: int = DEFAULT_LIMIT, progress_cb=None,
) -> list[tuple[str, float]]:
    live, unlabeled = candidate_frames(camera, feature, muted)
    if seed not in live:
        live = [*live, seed]
    kept, matrix = dedup.fetch_embeddings(camera, feature, live, method, progress_cb)
    return rank_candidates(kept, matrix, seed, unlabeled, limit)


def apply_label(camera: str, feature: str, frames: list[str], cls: str) -> tuple[int, list[str]]:
    """Label the still-live, still-unlabeled ``frames`` as ``cls``: ``(labeled, skipped)``.

    Skipped frames (deleted, already labeled or golden since the list was made, or not part of
    the feature) are left untouched.
    """
    live = set(dedup.live_frames(camera, feature))
    lab = labels.current_labels(camera, feature)
    ok = [f for f in dict.fromkeys(frames) if f in live and f not in lab]
    skipped = [f for f in dict.fromkeys(frames) if f not in set(ok)]
    return labels.set_labels_bulk(camera, feature, ok, cls, source="similar"), skipped
