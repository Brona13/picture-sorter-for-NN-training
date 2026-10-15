"""Central configuration for the curation tool.

All paths are derived from the project root (two levels above this ``app/backend/``
directory) so the project stays portable — copy the whole folder to another
machine and everything still resolves.

The cameras root can be overridden with the ``CURATION_CAMERAS_ROOT`` environment
variable, which is used by the test/verification harness to point at throwaway
synthetic images without touching the real ``cameras/`` folder.
"""
from __future__ import annotations

import os
from pathlib import Path

# Project root = two levels above app/backend/ (this directory).
PROJECT_ROOT = Path(__file__).resolve().parents[2]

# Cameras container (override for tests via CURATION_CAMERAS_ROOT).
CAMERAS_ROOT = Path(os.environ.get("CURATION_CAMERAS_ROOT", PROJECT_ROOT / "cameras"))

# Data folder holding the SQLite database (labels, golden marks, versions, score
# cache — never images). Override for tests via CURATION_DATA_DIR.
DATA_DIR = Path(os.environ.get("CURATION_DATA_DIR", PROJECT_ROOT / "data"))

# Class vocabulary shown in the Classify UI. Stored as free strings in the DB, so
# extending this list later needs no data migration.
CLASSES = ["OK", "NG"]

# Image file extensions we recognise (lower-case, with dot).
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}

# Common size (width, height) that cutouts are resized to before the pixel-based
# metrics (MSE, SSIM). Histogram comparison is size-independent.
STANDARD_SIZE = (256, 256)

# Number of bins per channel for the HSV colour histogram (H, S, V).
HIST_BINS = (50, 60, 3)

# Weights for combining normalised distances into a novelty score, per metric.
# Keys MUST match the metric names ``classify.py`` puts in its per-pair distance dict
# (classical: "histogram", "mse", "ssim"; neural: each active backbone name).
METRIC_WEIGHTS = {
    "histogram": 1.0,
    "mse": 1.0,
    "ssim": 1.0,
    "resnet18": 1.0,
    "resnet50": 1.0,
}

# Metrics are grouped into independent scoring *families*. Each family is combined
# by its own weighted average (above); the UI picks which family ranks candidates.
#   cpu = classical OpenCV/NumPy metrics (no model, always available)
#   nn  = neural ResNet embeddings (needs torch; optional)
METRIC_FAMILIES = {
    "cpu": ["histogram", "mse", "ssim"],
    "nn": ["resnet18", "resnet50"],
}
DEFAULT_FAMILY = "cpu"

# --- Neural (ResNet) embedding scoring (optional; requires torch) -------------
EMBEDDING_ENABLED = True            # auto-disabled if torch isn't installed
EMBEDDING_DEVICE = "auto"           # "auto" (GPU if present, CUDA or ROCm, else cpu) | "cpu" | "cuda"
EMBEDDING_BACKBONES = ["resnet18", "resnet50"]
EMBEDDING_BATCH_SIZE_CPU = 8       # conservative bounded inference batches
EMBEDDING_BATCH_SIZE_CUDA = 8      # safe default for modest GPU memory

# SQLite cache work is bounded so large cameras do not exceed the connection's
# parameter limit or hold one very large transaction in memory.
FEATURE_CACHE_QUERY_BATCH_SIZE = 400
FEATURE_CACHE_WRITE_BATCH_SIZE = 128
SCORING_VECTOR_BATCH_SIZE = 32       # decoded candidates retained at one time
CLASSICAL_COMPARISON_WORKERS = 4     # exact SSIM pairs evaluated concurrently

# --- Folder / file names within a camera -------------------------------------

UNSORTED_DIRNAME = "unsorted"

# Pseudo-feature used when comparing whole frames (no ROI defined).
WHOLE_FRAME_FEATURE = "whole-frame"
