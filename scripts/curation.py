"""Classical cutout feature extraction and image-distance functions.

The module extracts normalized HSV histograms and standardized grayscale
representations from ROI cutouts and provides histogram, MSE, and SSIM
distances plus their weighted combination. ``classify.py`` composes these
into the multi-class scoring pipeline.

Distances are nominally in ``[0, 1]``, where zero means identical. Their observed
scales are not necessarily comparable; see ``docs/methodology.md``.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from skimage.metrics import structural_similarity as ssim

import config


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


