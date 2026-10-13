"""Suggested goldens — the "most uncertain, spread for diversity" picker.

Given the current scored list, surface a compact set of unlabeled frames that would
sharpen class separation the most: those with the smallest margin between the two
nearest classes, thinned (farthest-point sampling in embedding space) so the picks
aren't five near-identical borderline frames.

Pure logic, no UI. See ``plans/curation-loop-enhancements.md`` (Phase 4).
"""
from __future__ import annotations

import numpy as np

import dedup
import embedding


POOL_K = 100                # uncertainty pool depth before diversity thinning
DEFAULT_N = 10
N_MIN, N_MAX = 3, 20


def _diversity_backbone() -> str | None:
    """Pick a backbone for farthest-point sampling; None means diversity is skipped."""
    have = embedding.backbones()
    for pref in ("resnet50", "resnet18"):
        if pref in have:
            return pref
    return None


def suggest(
    *,
    camera: str,
    feature: str,
    items,                              # list[classify.FrameScore]
    rank_method: str,
    n: int = DEFAULT_N,
    lab: dict[str, str],
    gold: dict[str, list[str]],
    diversity_backbone: str | None = None,
) -> list:
    """Return up to ``n`` FrameScore picks: most-uncertain-first, spread by
    farthest-point sampling in embedding space over the top ``POOL_K``.

    Pure function. No Streamlit, no session state. Designed to be smoke-tested.

    ``diversity_backbone=None`` auto-detects the best available ResNet; pass
    an explicit backbone name in tests to make results deterministic. When no
    ResNet is available, the picks fall back to the top-N by pure margin.
    """
    golden_frames = {f for frames in gold.values() for f in frames}
    candidates = [
        r for r in items
        if r.frame not in lab
        and r.frame not in golden_frames
        and rank_method in r.per_method
        and r.per_method[rank_method].leaning is not None
        and r.per_method[rank_method].margin is not None
    ]
    if not candidates:
        return []

    # Sort ascending by margin — smallest = most uncertain.
    candidates.sort(key=lambda r: r.per_method[rank_method].margin)

    if n >= len(candidates):
        return candidates

    pool = candidates[:POOL_K]

    backbone = diversity_backbone if diversity_backbone is not None else _diversity_backbone()
    if backbone is None:
        # No vector space available — give up on diversity, take the shakiest N.
        return pool[:n]

    kept_frames, matrix = dedup.fetch_embeddings(
        camera, feature, [r.frame for r in pool], backbone,
    )
    if matrix.shape[0] == 0:
        return pool[:n]

    # Preserve the by-margin ordering inside the pool, but index into the matrix
    # by frame name (fetch_embeddings drops unreadable frames).
    row_of = {f: i for i, f in enumerate(kept_frames)}
    orderable = [r for r in pool if r.frame in row_of]
    if len(orderable) <= n:
        return orderable

    picked_idx: list[int] = [row_of[orderable[0].frame]]      # start with shakiest
    picked_frames: list[str] = [orderable[0].frame]
    while len(picked_idx) < n:
        best_dist = -1.0
        best_row = -1
        for r in orderable:
            if r.frame in picked_frames:
                continue
            row = row_of[r.frame]
            # cosine distance from this row to its nearest already-picked row
            sims = matrix[picked_idx] @ matrix[row]                # already unit-norm
            nearest_sim = float(np.max(sims))
            dist = (1.0 - nearest_sim) / 2.0
            if dist > best_dist:
                best_dist = dist
                best_row = row
        if best_row < 0:
            break
        picked_idx.append(best_row)
        picked_frames.append(kept_frames[best_row])

    # Return the FrameScore objects in pick order.
    pick_set = set(picked_frames)
    frame_to_r = {r.frame: r for r in orderable}
    return [frame_to_r[f] for f in picked_frames if f in frame_to_r]
