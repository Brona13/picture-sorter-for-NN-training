"""Classical cutout feature extraction and image-distance functions.

The module extracts normalized HSV histograms and standardized grayscale
representations from ROI cutouts. It provides histogram, MSE, and SSIM distances
plus weighted combination and nearest-reference scoring helpers.

Distances are nominally in ``[0, 1]``, where zero means identical. Their observed
scales are not necessarily comparable; see ``docs/methodology.md``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from skimage.metrics import structural_similarity as ssim

import config
import embedding


# --- image / feature extraction ---------------------------------------------
def load_image(path: str | Path) -> np.ndarray:
    """Load an image as BGR uint8. Raises ``FileNotFoundError`` if unreadable.

    Uses ``imdecode`` so non-ASCII / Windows paths work reliably.
    """
    path = Path(path)
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {path}")
    return img


@dataclass
class CutoutFeatures:
    """Pre-computed representations of a cutout, reused across comparisons."""

    hist: np.ndarray  # normalised HSV histogram
    gray: np.ndarray  # float32 grayscale in [0, 1] resized to STANDARD_SIZE
    embeddings: dict[str, np.ndarray] = field(default_factory=dict)  # backbone -> L2-norm vector


def _hsv_histogram(bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist(
        [hsv], [0, 1, 2], None, config.HIST_BINS, [0, 180, 0, 256, 0, 256]
    )
    cv2.normalize(hist, hist)
    return hist.flatten()


def _gray_standard(bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, config.STANDARD_SIZE, interpolation=cv2.INTER_AREA)
    return gray.astype(np.float32) / 255.0


def extract_features(cutout: np.ndarray, backbones: tuple[str, ...] = ()) -> CutoutFeatures:
    """Extract classical features always; neural embeddings only for ``backbones``
    (so CPU-only scoring never loads or runs the model)."""
    embs = {b: embedding.embed(cutout, b) for b in backbones}
    return CutoutFeatures(
        hist=_hsv_histogram(cutout), gray=_gray_standard(cutout), embeddings=embs
    )


# --- per-metric distances (0 = identical, 1 = different) ---------------------
def _hist_distance(a: np.ndarray, b: np.ndarray) -> float:
    # Bhattacharyya distance is already in [0, 1].
    return float(cv2.compareHist(a, b, cv2.HISTCMP_BHATTACHARYYA))


def _mse_distance(a: np.ndarray, b: np.ndarray) -> float:
    # a, b are grayscale in [0, 1]; mean squared error is therefore in [0, 1].
    return float(np.mean((a - b) ** 2))


def _ssim_distance(a: np.ndarray, b: np.ndarray) -> float:
    score = ssim(a, b, data_range=1.0)
    # SSIM in [-1, 1]; 1 - score gives a distance. Clamp to [0, 1].
    return float(np.clip(1.0 - score, 0.0, 1.0))


def distance_between(a: CutoutFeatures, b: CutoutFeatures) -> dict[str, float]:
    """Per-metric distances between two cutouts (classical + any shared embeddings)."""
    d = {
        "histogram": _hist_distance(a.hist, b.hist),
        "mse": _mse_distance(a.gray, b.gray),
        "ssim": _ssim_distance(a.gray, b.gray),
    }
    for name, va in a.embeddings.items():
        vb = b.embeddings.get(name)
        if vb is not None:
            d[name] = embedding.cosine_distance(va, vb)
    return d


def combine(
    distances: dict[str, float],
    weights: dict[str, float] | None = None,
    keys: list[str] | None = None,
) -> float:
    """Weighted average of per-metric distances -> single combined distance.

    ``keys`` optionally restricts the average to one family's metrics.
    """
    weights = weights or config.METRIC_WEIGHTS
    ks = [k for k in distances if keys is None or k in keys]
    total_w = sum(weights.get(k, 0.0) for k in ks)
    if total_w <= 0:
        vals = [distances[k] for k in ks]
        return float(np.mean(vals)) if vals else 0.0
    return sum(distances[k] * weights.get(k, 0.0) for k in ks) / total_w


@dataclass
class Score:
    """Result of scoring one candidate against the golden set."""

    novelty: float                 # combined distance to nearest golden (higher = more novel)
    per_metric: dict[str, float]   # the nearest golden's per-metric distances


def score_against_golden(
    candidate: CutoutFeatures,
    golden: list[CutoutFeatures],
    family: str = "cpu",
    weights: dict[str, float] | None = None,
) -> Score:
    """Novelty = combined distance to the *nearest* golden cutout, within one family.

    Each family (see ``config.METRIC_FAMILIES``) is scored independently. Returns
    novelty 1.0 (maximally novel) when there is no golden reference.
    """
    keys = config.METRIC_FAMILIES.get(family)
    if not golden:
        fam = keys or ["histogram", "mse", "ssim"]
        return Score(novelty=1.0, per_metric={k: 1.0 for k in fam})

    best: dict[str, float] | None = None
    best_combined = float("inf")
    for g in golden:
        d = distance_between(candidate, g)
        fd = {k: d[k] for k in d if keys is None or k in keys} or d
        c = combine(fd, weights)
        if c < best_combined:
            best_combined = c
            best = fd
    assert best is not None
    return Score(novelty=best_combined, per_metric=best)


def build_reference_features(
    frame_paths: list[Path], roi, backbones: tuple[str, ...] = ()
) -> list[CutoutFeatures]:
    """Load frames, crop the ROI, and extract features for each (reference set)."""
    feats: list[CutoutFeatures] = []
    for p in frame_paths:
        img = load_image(p)
        feats.append(extract_features(roi.crop(img), backbones))
    return feats
