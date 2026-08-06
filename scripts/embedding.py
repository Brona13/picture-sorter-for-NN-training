"""Neural (ResNet) embedding metric — an optional, GPU-capable scoring family.

PyTorch is an **optional** dependency. This module imports it lazily, so the rest of
the tool runs unchanged when torch is not installed: ``available()`` returns ``False``
and the UI simply doesn't offer the neural scoring family.

Install (only when you want neural scoring):
  * CPU (AMD / no Nvidia):  pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
  * Nvidia GPU:             install the matching CUDA build from https://pytorch.org
"""
from __future__ import annotations

import threading
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image

import config
import perf

# --- lazy torch import -------------------------------------------------------
_lock = threading.Lock()
_torch = None
_import_failed = False


def _ensure_torch() -> bool:
    """Import torch/torchvision once. Returns True if they're importable."""
    global _torch, _import_failed
    if _torch is not None:
        return True
    if _import_failed:
        return False
    with _lock:
        if _torch is not None:
            return True
        if _import_failed:
            return False
        try:
            import torch  # noqa: F401
            import torchvision  # noqa: F401

            _torch = torch
        except Exception:  # noqa: BLE001 - any failure -> feature just unavailable
            _import_failed = True
    return _torch is not None


def available() -> bool:
    """True if neural scoring can run (enabled in config AND torch importable)."""
    if not getattr(config, "EMBEDDING_ENABLED", True):
        return False
    return _ensure_torch()


def active_device() -> str:
    """The device embeddings will run on: 'cuda' if available/requested else 'cpu'."""
    if not available():
        return "cpu"
    pref = getattr(config, "EMBEDDING_DEVICE", "auto")
    if pref in ("auto", "cuda"):
        return "cuda" if _torch.cuda.is_available() else "cpu"
    return "cpu"


# --- model registry ----------------------------------------------------------
def _backbone_specs() -> dict:
    """name -> (constructor, weights enum). Imported lazily (needs torchvision)."""
    from torchvision.models import (  # noqa: PLC0415
        ResNet18_Weights,
        ResNet50_Weights,
        resnet18,
        resnet50,
    )

    return {
        "resnet18": (resnet18, ResNet18_Weights.IMAGENET1K_V1),
        "resnet50": (resnet50, ResNet50_Weights.IMAGENET1K_V1),
    }


def backbones() -> list[str]:
    """Backbone names offered to the user (config order, restricted to known ones)."""
    known = set(_backbone_specs()) if available() else set()
    return [b for b in getattr(config, "EMBEDDING_BACKBONES", []) if b in known]


@lru_cache(maxsize=4)
def _load(backbone: str, device: str):
    """Load a frozen, head-less pretrained model + its preprocessing (cached)."""
    ctor, weights = _backbone_specs()[backbone]
    model = ctor(weights=weights)
    model.fc = _torch.nn.Identity()  # drop classifier -> penultimate features
    model.eval()
    model.to(device)
    return model, weights.transforms()  # transforms() = resize/crop/normalize for these weights


def get_model(backbone: str):
    if not available():
        raise RuntimeError("torch/torchvision not available")
    if backbone not in _backbone_specs():
        raise ValueError(f"unknown backbone: {backbone!r}")
    return _load(backbone, active_device())


# --- embedding + distance ----------------------------------------------------
def embed(cutout_bgr: np.ndarray, backbone: str) -> np.ndarray:
    """Return an L2-normalized float32 embedding for a BGR cutout."""
    return embed_batch([cutout_bgr], backbone)[0]


def _configured_batch_size(device: str) -> int:
    key = "EMBEDDING_BATCH_SIZE_CUDA" if device == "cuda" else "EMBEDDING_BATCH_SIZE_CPU"
    return max(1, int(getattr(config, key, 8)))


def _infer_batch(model, preprocess, images: list[np.ndarray], backbone: str, device: str):
    """Infer one batch, recursively reducing it if the device rejects its size."""
    try:
        with perf.span(f"embedding.{backbone}"):
            perf.count(f"embedding.{backbone}.batches")
            perf.count(f"embedding.{backbone}.images", len(images))
            tensors = []
            for cutout_bgr in images:
                rgb = cv2.cvtColor(cutout_bgr, cv2.COLOR_BGR2RGB)
                tensors.append(preprocess(Image.fromarray(rgb)))
            batch = _torch.stack(tensors).to(device)
            inference_context = getattr(_torch, "inference_mode", _torch.no_grad)
            with inference_context():
                feats = model(batch)
            matrix = feats.detach().cpu().numpy().astype(np.float32)
            norms = np.linalg.norm(matrix, axis=1, keepdims=True)
            return np.divide(matrix, norms, out=np.zeros_like(matrix), where=norms > 0)
    except RuntimeError:
        if len(images) <= 1:
            raise
        perf.count(f"embedding.{backbone}.batch_retries")
        if device == "cuda" and hasattr(_torch.cuda, "empty_cache"):
            _torch.cuda.empty_cache()
        middle = len(images) // 2
        left = _infer_batch(model, preprocess, images[:middle], backbone, device)
        right = _infer_batch(model, preprocess, images[middle:], backbone, device)
        return np.concatenate([left, right], axis=0)


def iter_embed_batches(
    cutouts_bgr: list[np.ndarray], backbone: str, batch_size: int | None = None,
):
    """Yield ``(start_index, normalized_matrix)`` for bounded inference batches."""
    if not cutouts_bgr:
        return
    model, preprocess = get_model(backbone)
    device = active_device()
    size = max(1, int(batch_size or _configured_batch_size(device)))
    for start in range(0, len(cutouts_bgr), size):
        images = cutouts_bgr[start : start + size]
        yield start, _infer_batch(model, preprocess, images, backbone, device)


def embed_batch(
    cutouts_bgr: list[np.ndarray], backbone: str, batch_size: int | None = None,
) -> list[np.ndarray]:
    """Return normalized embeddings in input order using bounded model calls."""
    vectors: list[np.ndarray] = []
    for _start, matrix in iter_embed_batches(cutouts_bgr, backbone, batch_size):
        vectors.extend(matrix)
    return vectors


def cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine distance in [0, 1] for L2-normalized vectors (0 = identical)."""
    d = (1.0 - float(np.dot(a, b))) / 2.0
    return max(0.0, min(1.0, d))
