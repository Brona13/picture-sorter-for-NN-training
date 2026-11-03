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
import methods_config


POOL_K = 100                # uncertainty pool depth before diversity thinning
DEFAULT_N = 10
N_MIN, N_MAX = 3, 20


def _diversity_backbone() -> str | None:
    """Pick a backbone for farthest-point sampling; None means diversity is skipped."""
    have = methods_config.active_backbones()  # only the neural methods switched on in Configuration
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
    labeled_only: bool = False,
) -> list:
    """Return up to ``n`` FrameScore picks: most-uncertain-first, spread by
    farthest-point sampling in embedding space over the top ``POOL_K``.

    Pure function. No Streamlit, no session state. Designed to be smoke-tested.

    ``labeled_only`` (a step-2 Classifier, whose labels all come from the freeze) picks among the frames that already carry
    a label and are not golden yet, instead of the unlabeled ones.

    ``diversity_backbone=None`` auto-detects the best available ResNet; pass
    an explicit backbone name in tests to make results deterministic. When no
    ResNet is available, the picks fall back to the top-N by pure margin.
    """
    golden_frames = {f for frames in gold.values() for f in frames}
    candidates = [
        r for r in items
        if (r.frame in lab if labeled_only else r.frame not in lab)
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


# --- the center of the pictures in view (v1.157.0) -----------------------------------------------------------------------------

def _neighbour_k(n: int) -> int:
    """How many nearest neighbours define a picture's neighbourhood: about an eighth of the pictures, between 3 and 50. Large enough that
    a small tight group cannot outrank the main crowd (its neighbourhood spills out of the group and its density drops)."""
    return max(1, min(n - 1, max(3, min(50, round(n / 8)))))


def density(matrix: np.ndarray, k: int, chunk: int = 512) -> np.ndarray:
    """Per row of a unit-norm matrix: the mean cosine similarity to its ``k`` nearest other rows (its **density**: high = many close
    neighbours). Done in chunks, so no N x N matrix is held."""
    n = matrix.shape[0]
    out = np.zeros(n, dtype=np.float32)
    for start in range(0, n, chunk):
        sims = matrix[start:start + chunk] @ matrix.T
        rows = np.arange(sims.shape[0])
        sims[rows, rows + start] = -np.inf  # a picture is not its own neighbour
        out[start:start + chunk] = np.partition(sims, n - 1 - k, axis=1)[:, n - k:].mean(axis=1)  # the k largest per row
    return out


def peak_distance(matrix: np.ndarray, rank: np.ndarray, chunk: int = 512) -> np.ndarray:
    """Per row: the cosine distance (1 - similarity) to the nearest row that ranks higher (``rank`` 0 = densest). The densest row has
    none and gets 2.0, the largest possible. A picture in the flank of a crowd has a denser one close by (small value); the peak of
    another look has none close by (large value)."""
    n = matrix.shape[0]
    out = np.full(n, 2.0, dtype=np.float32)
    for start in range(0, n, chunk):
        sims = matrix[start:start + chunk] @ matrix.T
        higher = rank[None, :] < rank[start:start + chunk][:, None]
        sims = np.where(higher, sims, -np.inf)
        best = sims.max(axis=1)
        out[start:start + chunk] = np.where(np.isfinite(best), 1.0 - best, 2.0)
    return out


def center(
    *,
    camera: str,
    feature: str,
    items,                              # list[classify.FrameScore]: the pictures of the current view
    n: int = 3,
    gold: dict[str, list[str]],
    diversity_backbone: str | None = None,
) -> list:
    """The pictures at the **centers** of the view: the peaks of the density in the embedding space, the main crowd's first.

    Density-peaks method: a picture's density is its mean similarity to its nearest neighbours (so a few outliers cannot drag a peak
    away from where most pictures are, as an average would). A picture is a peak of a look when it is dense *and* far from every denser
    picture; pictures in the flank of a crowd have a denser one nearby and are not. The densest picture comes first, then the peaks
    of the other looks by density x distance. Pictures that are golden already are not picked, but stay in the crowd the density is
    measured on (a look whose peak is golden already is covered). Needs no goldens and no scores: only embeddings. ``[]`` without a
    ResNet or with fewer than three pictures.
    """
    backbone = diversity_backbone if diversity_backbone is not None else _diversity_backbone()
    if backbone is None or len(items) < 3:
        return []
    kept, matrix = dedup.fetch_embeddings(camera, feature, [r.frame for r in items], backbone)
    count = len(kept)
    if count < 3:
        return []
    k = _neighbour_k(count)
    dens = density(matrix, k)
    # Equal densities (to 5 decimals) are ordered by the mean similarity to the nearest three quarters of the view: central, and still
    # blind to the farthest quarter, so outliers cannot pull it. File order never decides.
    wide = density(matrix, max(k, int(0.75 * (count - 1))))
    order = np.lexsort((-wide, -np.round(dens, 5)))
    rank = np.empty(count, dtype=np.int64)
    rank[order] = np.arange(count)
    gamma = dens * peak_distance(matrix, rank)
    by_frame = {r.frame: r for r in items}
    golden = {f for frames in gold.values() for f in frames}
    chosen = [int(i) for i in np.lexsort((rank, -np.round(gamma, 6))) if kept[int(i)] not in golden][:n]
    return [by_frame[kept[i]] for i in chosen]
