"""Start goldens (v1.168.0): the first goldens of a class, chosen from the embeddings alone.

In a step-2 Classifier every picture already has its OK or NG label (from the freeze), so only the goldens are open. Scores need
one golden per class, which makes the first golden a guess; these methods need no goldens and no scores. Everything here is a
pure function of "a set of frames plus their embedding" (``analyse``), so the same code serves the later import-with-labels and
production-feedback flows; ``suggest`` only fetches the frames and embeddings of one class.

Opinions are never blended: one embedding (a ResNet) is used, and nothing here reads classical scores. Distances are turned into
**percentile ranks** among the class's own pairs, because ResNet distances between near-identical frames lie in a very narrow
range; equal ranks are ties, and a tie is broken by a secondary measure and finally by a hash of the file name, never by the
order the files happen to be in.
"""
from __future__ import annotations

import hashlib
import math

import numpy as np

import dedup
import suggest_goldens

METHODS = ("facility", "medoid", "density", "cluster", "farthest", "boundary")
DEFAULT_METHOD = "facility"
N_MAX = suggest_goldens.N_MAX
COVER_SHARE = 4         # a picture is covered by a golden at about the distance of its nearest quarter of the class
COVER_FLOOR = 0.02      # the cover radius is never below the closest 2% of all pairs of the class
GAIN_STOP = 0.05        # the suggested count stops when one more golden adds less than this share of the class
MIN_CLUSTER_SHARE = 0.02  # clusters smaller than this share of the class (and under 2 pictures) are taken for noise
OUTLIER_SHARE = 0.05    # farthest-point coverage leaves out the 5% most isolated pictures
RANK_MAX = 3000         # above this many pictures per class the raw cosine distance, scaled to 0..1, is used instead of ranks
TIE_DECIMALS = 6


def pair_distance(matrix: np.ndarray) -> np.ndarray:
    """Cosine distance between all rows of a unit-norm matrix, 0 on the diagonal."""
    d = 1.0 - matrix @ matrix.T
    np.fill_diagonal(d, 0.0)
    return np.clip(d, 0.0, 2.0).astype(np.float32)


def rank_distance(dist: np.ndarray) -> np.ndarray:
    """Each distance as the share of the class's pairs that are at most as far: 0..1, equal distances share one value (a tie)."""
    n = dist.shape[0]
    if n < 2:
        return np.zeros_like(dist)
    if n > RANK_MAX:
        return (dist / max(float(dist.max()), 1e-9)).astype(np.float32)
    iu = np.triu_indices(n, 1)
    vals = np.round(dist[iu], TIE_DECIMALS)
    _, inv, counts = np.unique(vals, return_inverse=True, return_counts=True)
    share = (np.cumsum(counts) / counts.sum()).astype(np.float32)[inv]
    out = np.zeros_like(dist)
    out[iu] = share
    return out + out.T


def tie_key(frames: list[str]) -> np.ndarray:
    """A fixed, arbitrary order of the frames that does not follow the file order (a hash of the name): the last word in a tie."""
    return np.array([int.from_bytes(hashlib.sha1(f.encode("utf-8")).digest()[:6], "big") for f in frames], dtype=np.int64)


def _rounded(x: np.ndarray) -> np.ndarray:
    return np.round(np.asarray(x, dtype=np.float64), TIE_DECIMALS)


def _best(primary: np.ndarray, secondary: np.ndarray, tie: np.ndarray, allowed: np.ndarray) -> int:
    """The index with the smallest primary among the allowed ones; equal primaries go by the smaller secondary, then the tie key."""
    idx = np.flatnonzero(allowed)
    order = np.lexsort((tie[idx], _rounded(secondary[idx]), _rounded(primary[idx])))
    return int(idx[order[0]])


# --- the methods -----------------------------------------------------------------------------------------------------------------

def medoids(rank: np.ndarray, raw: np.ndarray, tie: np.ndarray, allowed: np.ndarray, n: int) -> list[int]:
    """The ``n`` most central pictures: the smallest mean distance to all the others (the medoid first)."""
    centrality, fallback = rank.mean(axis=1), raw.mean(axis=1)
    left = allowed.copy()
    out: list[int] = []
    while len(out) < n and left.any():
        i = _best(centrality, fallback, tie, left)
        out.append(i)
        left[i] = False
    return out


def facility(rank: np.ndarray, raw: np.ndarray, tie: np.ndarray, allowed: np.ndarray, n: int, have: list[int]) -> list[int]:
    """Greedy facility location: each pick is the picture that lowers the summed distance of every picture to its nearest golden the
    most. With no golden yet the first pick is the medoid. Goldens that exist (``have``) count as already placed."""
    best = rank[have].min(axis=0).copy() if have else np.ones(rank.shape[0], dtype=np.float32)
    left = allowed.copy()
    centrality, fallback = rank.mean(axis=1), raw.mean(axis=1)
    out: list[int] = []
    while len(out) < n and left.any():
        gain = np.maximum(best[None, :] - rank, 0.0).sum(axis=1)
        # the largest gain wins; equal gains go to the more central picture, then by the name hash
        order = np.flatnonzero(left)
        pick = order[np.lexsort((tie[order], _rounded(fallback[order]), _rounded(centrality[order]), -_rounded(gain[order])))[0]]
        out.append(int(pick))
        left[pick] = False
        best = np.minimum(best, rank[pick])
    return out


def density_peaks(matrix: np.ndarray, frames: list[str], allowed: np.ndarray, n: int) -> list[int]:
    """The peaks of the density in the embedding, the main crowd's first (the Suggested center of v1.157.0, over one class)."""
    golden = {f for f, ok in zip(frames, allowed) if not ok}
    return suggest_goldens.peaks(frames, matrix, n, golden)


def cluster_medoids(rank: np.ndarray, raw: np.ndarray, tie: np.ndarray, allowed: np.ndarray, clusters: int) -> list[int]:
    """Average-linkage clustering into ``clusters`` groups, the medoid of each; groups that are tiny (noise) are left out and the
    biggest group comes first."""
    from scipy.cluster.hierarchy import fcluster, linkage  # noqa: PLC0415
    from scipy.spatial.distance import squareform  # noqa: PLC0415

    n = rank.shape[0]
    if n < 3 or clusters < 2:
        return medoids(rank, raw, tie, allowed, 1)
    labels = fcluster(linkage(squareform(rank.astype(np.float64), checks=False), "average"), min(clusters, n), "maxclust")
    floor = max(2, math.ceil(MIN_CLUSTER_SHARE * n))
    out: list[tuple[int, int]] = []
    for group in np.unique(labels):
        members = np.flatnonzero(labels == group)
        if len(members) < floor:
            continue
        inside = np.zeros(n, dtype=bool)
        inside[members] = True
        sub = rank[np.ix_(members, members)].mean(axis=1)
        sub_raw = raw[np.ix_(members, members)].mean(axis=1)
        primary, secondary = np.full(n, np.inf), np.full(n, np.inf)
        primary[members], secondary[members] = sub, sub_raw
        pool = inside & allowed
        if pool.any():
            out.append((len(members), _best(primary, secondary, tie, pool)))
    out.sort(key=lambda t: (-t[0], int(tie[t[1]])))
    return [i for _, i in out]


def outlier_mask(rank: np.ndarray, k: int) -> np.ndarray:
    """The most isolated pictures: the largest mean distance to their ``k`` nearest others (the top ``OUTLIER_SHARE``, none in a small class)."""
    n = rank.shape[0]
    if n < 20:
        return np.zeros(n, dtype=bool)
    k = max(1, min(k, n - 1))
    nearest = np.sort(rank + np.diag(np.full(n, np.inf, dtype=np.float32)), axis=1)[:, :k].mean(axis=1)
    cut = np.quantile(nearest, 1.0 - OUTLIER_SHARE)
    return nearest > cut


def farthest(rank: np.ndarray, raw: np.ndarray, tie: np.ndarray, allowed: np.ndarray, n: int, have: list[int]) -> tuple[list[int], int]:
    """Farthest-point coverage over the pictures that are not outliers (it chases outliers, which are the likeliest mislabels): start
    at the medoid (or from the goldens that exist), then always the picture farthest from every pick. Also returns how many were left out."""
    isolated = outlier_mask(rank, suggest_goldens._neighbour_k(rank.shape[0]))
    pool = allowed & ~isolated
    centrality, fallback = rank.mean(axis=1), raw.mean(axis=1)
    near = rank[have].min(axis=0) if have else None
    out: list[int] = []
    while len(out) < n and pool.any():
        if near is None:
            i = _best(centrality, fallback, tie, pool)
        else:
            idx = np.flatnonzero(pool)
            i = int(idx[np.lexsort((tie[idx], _rounded(centrality[idx]), -_rounded(near[idx])))[0]])
        out.append(i)
        pool[i] = False
        near = rank[i] if near is None else np.minimum(near, rank[i])
    return out, int(isolated.sum())


def boundary(matrix: np.ndarray, other: np.ndarray, tie: np.ndarray, allowed: np.ndarray, n: int) -> list[int]:
    """The pictures of this class nearest the other class(es): the most similar to any picture of another class, then the mean of
    their three nearest. They are also the likeliest mislabels, so they are offered after the centres."""
    sims = matrix @ other.T
    top = np.sort(sims, axis=1)[:, ::-1]
    nearest, three = top[:, 0], top[:, : min(3, top.shape[1])].mean(axis=1)
    idx = np.flatnonzero(allowed)
    order = np.lexsort((tie[idx], -_rounded(three[idx]), -_rounded(nearest[idx])))
    return [int(i) for i in idx[order][:n]]


# --- coverage ------------------------------------------------------------------------------------------------------------------

def cover_radius(rank: np.ndarray) -> float:
    """How close "covered" is, in rank distance: the typical distance of a picture to its nearest quarter of the class (the median, over the
    pictures, of the distance to their k-th nearest), so a golden covers the pictures that look like it and not a whole other look."""
    n = rank.shape[0]
    k = max(1, min(max(suggest_goldens._neighbour_k(n), n // COVER_SHARE), n - 1))
    kth = np.sort(rank + np.diag(np.full(n, np.inf, dtype=np.float32)), axis=1)[:, k - 1]
    return float(max(np.median(kth), COVER_FLOOR))


def coverage_curve(rank: np.ndarray, picks: list[int], have: list[int], radius: float) -> list[float]:
    """The share of the class within ``radius`` of a golden after 1, 2, ... picks (the goldens that exist count from the start)."""
    near = rank[have].min(axis=0) if have else np.ones(rank.shape[0], dtype=np.float32)
    out = []
    for i in picks:
        near = np.minimum(near, rank[i])
        out.append(float(np.mean(near <= radius)))
    return out


def suggested_count(curve: list[float]) -> int:
    """How many picks are worth making: stop at the first pick whose successor adds less than ``GAIN_STOP`` of the class."""
    for c in range(1, len(curve)):
        if curve[c] - curve[c - 1] < GAIN_STOP:
            return c
    return len(curve)


# --- the whole analysis of one class ---------------------------------------------------------------------------------------------

def analyse(frames: list[str], matrix: np.ndarray, golden: set[str], method: str, n: int, other: np.ndarray | None = None) -> dict:
    """The suggestion for one class: ``picks`` (row indexes into ``frames``, best first), the coverage curve and the suggested count.

    ``frames`` / ``matrix`` are the class's pictures and their unit-norm embeddings; ``golden`` the frames that are golden already
    (they stay in the crowd but are never picked); ``other`` the embeddings of the other class(es), for ``boundary``.
    """
    if method not in METHODS:
        raise ValueError(f"Unknown method: {method}")
    count = len(frames)
    n = max(1, min(int(n), N_MAX))
    out = {"method": method, "count": count, "picks": [], "coverage": [], "suggested": 0, "radius": 0.0, "left_out": 0, "risky": method == "boundary"}
    if count < 3:
        return out
    have = [i for i, f in enumerate(frames) if f in golden]
    allowed = np.array([f not in golden for f in frames])
    tie = tie_key(frames)
    raw = pair_distance(matrix)
    rank = rank_distance(raw)
    if method == "facility":
        picks = facility(rank, raw, tie, allowed, n, have)
    elif method == "medoid":
        picks = medoids(rank, raw, tie, allowed, n)
    elif method == "density":
        picks = density_peaks(matrix, frames, allowed, n)
    elif method == "cluster":
        picks = cluster_medoids(rank, raw, tie, allowed, n)
    elif method == "farthest":
        picks, out["left_out"] = farthest(rank, raw, tie, allowed, n, have)
    else:
        picks = boundary(matrix, other, tie, allowed, n) if other is not None and len(other) else []
    radius = cover_radius(rank)
    curve = coverage_curve(rank, picks, have, radius)
    out.update(radius=radius, picks=picks, coverage=curve, suggested=suggested_count(curve) if picks else 0)
    return out


# --- fetching one class ---------------------------------------------------------------------------------------------------------

def suggest(camera: str, feature: str, cls: str, lab: dict[str, str], gold: dict[str, list[str]], hidden: set[str],
            method: str, n: int, backbone: str | None) -> dict:
    """The suggestion for the pictures labeled ``cls`` in the feature: the frames labeled and shown (not deleted or muted), their
    embeddings in the feature's own picture (a Box rectangle in a step-2 Classifier), no scores needed."""
    result = {"available": False, "backbone": backbone, "cls": cls, "method": method, "count": 0, "picks": [], "coverage": [], "suggested": 0,
              "radius": 0.0, "left_out": 0, "risky": method == "boundary", "n_max": N_MAX}
    if backbone is None:
        return result
    mine = sorted(f for f, c in lab.items() if c == cls and f not in hidden)
    kept, matrix = dedup.fetch_embeddings(camera, feature, mine, backbone)
    other = None
    if method == "boundary":
        theirs = sorted(f for f, c in lab.items() if c != cls and f not in hidden)
        _, other = dedup.fetch_embeddings(camera, feature, theirs, backbone) if theirs else ([], None)
    golden = {f for fs in gold.values() for f in fs}
    done = analyse(list(kept), matrix, golden, method, n, other)
    result.update({k: v for k, v in done.items() if k != "picks"})
    result["picks"] = [{"frame": kept[i], "label": cls} for i in done["picks"]]
    result["available"] = bool(done["picks"])
    return result
