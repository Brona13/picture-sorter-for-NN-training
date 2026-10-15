"""Exemplar-based object detector (OWL-ViT, image-guided) for the Detector page.

The user marks 1-3 exemplar boxes on frames of a feature; the detector finds the most
similar object in every other frame's ROI crop. No training: a pretrained model is
downloaded once from Hugging Face and run locally (CPU, or a GPU when available: Nvidia CUDA or AMD ROCm builds of PyTorch).
Optional dependency: see ``requirements-detector.txt``. Everything model-specific lives
behind a *backend* callable so tests (and other models) can replace it::

    backend(target_bgr, query_crops_bgr, topk) -> [(box, score), ...]  best first

where ``box`` is ``{x, y, w, h}`` normalised to the target crop.
"""
from __future__ import annotations

from collections.abc import Callable
from functools import lru_cache

import cv2
import numpy as np

import datamodel
import detections
import engine
import labels
import preprocess
import vision_settings

import curation

MODEL_ID = "google/owlvit-base-patch32"
NMS_IOU = 0.5

Backend = Callable[[np.ndarray, list[np.ndarray], int], list[tuple[dict, float]]]


class DetectorError(RuntimeError):
    """The detector cannot run (missing dependency, no exemplars, unreadable exemplar)."""


_backend: Backend | None = None


def set_backend(backend: Backend | None) -> None:
    """Install a replacement backend (tests); ``None`` restores the OWL-ViT default."""
    global _backend
    _backend = backend


def available() -> bool:
    try:
        import torch  # noqa: F401, PLC0415
        import transformers  # noqa: F401, PLC0415
    except ImportError:
        return False
    return True


def _iou(a: dict, b: dict) -> float:
    ix = max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    iy = max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def merge(found: list[tuple[dict, float]], topk: int) -> list[tuple[dict, float]]:
    """Non-maximum suppression across exemplars, then the ``topk`` best boxes."""
    kept: list[tuple[dict, float]] = []
    for box, score in sorted(found, key=lambda t: -t[1]):
        if all(_iou(box, k) < NMS_IOU for k, _ in kept):
            kept.append((box, score))
        if len(kept) == topk:
            break
    return kept


@lru_cache(maxsize=1)
def _load_owl():
    if not available():
        raise DetectorError(
            "The detector needs torch and transformers (pip install -r requirements-detector.txt)."
        )
    import torch  # noqa: PLC0415
    from transformers import OwlViTForObjectDetection, OwlViTProcessor  # noqa: PLC0415

    device = "cuda" if torch.cuda.is_available() else "cpu"
    processor = OwlViTProcessor.from_pretrained(MODEL_ID)
    model = OwlViTForObjectDetection.from_pretrained(MODEL_ID).to(device).eval()
    return torch, processor, model, device


def _owl_backend(target: np.ndarray, queries: list[np.ndarray], topk: int):
    from PIL import Image  # noqa: PLC0415

    torch, processor, model, device = _load_owl()
    height, width = target.shape[:2]
    image = Image.fromarray(cv2.cvtColor(target, cv2.COLOR_BGR2RGB))
    found: list[tuple[dict, float]] = []
    for query in queries:
        query_image = Image.fromarray(cv2.cvtColor(query, cv2.COLOR_BGR2RGB))
        inputs = processor(images=image, query_images=query_image, return_tensors="pt").to(device)
        with torch.no_grad():
            outputs = model.image_guided_detection(**inputs)
        sizes = torch.tensor([[height, width]], device=device)
        result = processor.post_process_image_guided_detection(
            outputs=outputs, threshold=0.0, nms_threshold=0.3, target_sizes=sizes
        )[0]
        for (x0, y0, x1, y1), score in zip(result["boxes"].tolist(), result["scores"].tolist()):
            x0, y0 = max(0.0, x0), max(0.0, y0)
            x1, y1 = min(float(width), x1), min(float(height), y1)
            if x1 > x0 and y1 > y0:
                found.append(
                    ({"x": x0 / width, "y": y0 / height, "w": (x1 - x0) / width, "h": (y1 - y0) / height},
                     float(score))
                )
    return merge(found, topk)


def _get_backend() -> Backend:
    return _backend or _owl_backend


def _filtered_crop(camera: str, roi, frame: str, settings: dict) -> np.ndarray:
    """The frame's ROI crop with the feature's pre-processing filter (never the mask)."""
    crop = roi.crop(curation.load_image(datamodel.unsorted_dir(camera) / frame))
    flt = settings["filter"]
    return preprocess.apply(crop, flt["name"], flt["params"]) if flt else crop


def exemplar_crops(camera: str, feature: str, settings: dict) -> list[np.ndarray]:
    roi = engine.resolve_roi(camera, feature)
    crops = []
    for ex in settings["detector"]["exemplars"]:
        try:
            crop = _filtered_crop(camera, roi, ex["frame"], settings)
        except FileNotFoundError as exc:
            raise DetectorError(f"Exemplar frame {ex['frame']!r} no longer exists") from exc
        h, w = crop.shape[:2]
        b = ex["box"]
        x0, y0 = int(b["x"] * w), int(b["y"] * h)
        x1, y1 = max(x0 + 1, int((b["x"] + b["w"]) * w)), max(y0 + 1, int((b["y"] + b["h"]) * h))
        crops.append(crop[y0:y1, x0:x1])
    return crops


def run(camera: str, feature: str, report: Callable[[dict], None] = lambda _p: None) -> dict:
    """Detect the object in every frame of ``feature`` that no human has decided yet."""
    settings = vision_settings.get(camera, feature)
    det = settings["detector"]
    if not det or not det["exemplars"]:
        raise DetectorError("Add at least one exemplar first")
    backend = _get_backend()
    queries = exemplar_crops(camera, feature, settings)
    sig = vision_settings.detection_signature(settings)
    roi = engine.resolve_roi(camera, feature)
    hmap = labels.hash_map(camera)
    frames = datamodel.frames_for_feature(camera, feature)
    detected = skipped = unreadable = needs_review = 0
    for i, frame in enumerate(frames):
        report({"done": i, "total": len(frames)})
        h = labels.frame_hash(camera, frame, hmap)
        try:
            crop = _filtered_crop(camera, roi, frame, settings)
        except FileNotFoundError:
            unreadable += 1
            continue
        found = backend(crop, queries, det["topk"])
        if not detections.save_auto(camera, feature, h, found, sig):
            skipped += 1
            continue
        detected += 1
        if not found or found[0][1] < det["threshold"]:
            needs_review += 1
    report({"done": len(frames), "total": len(frames)})
    vision_settings.purge_derived(camera, feature)
    return {"detected": detected, "skipped_human": skipped, "unreadable": unreadable,
            "needs_review": needs_review}
