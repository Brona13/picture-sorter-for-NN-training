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

import hashlib
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
MODEL_SOURCE = "huggingface.co"
MODEL_DOWNLOAD_MB = 600  # approximate size of the weights, shown to the user before downloading
NMS_IOU = 0.5
BATCH = 8  # frames encoded together on the default (OWL-ViT) backend
HALF = False  # half precision on a GPU is about 1.4x faster but changes which boxes win on ambiguous frames; opt in here
_QUERY_NMS = 0.3  # overlap above which a weaker box of one exemplar is dropped (as the model's own post-processing did)

Backend = Callable[[np.ndarray, list[np.ndarray], int], list[tuple[dict, float]]]


class DetectorError(RuntimeError):
    """The detector cannot run (missing dependency, no exemplars, unreadable exemplar)."""


_backend: Backend | None = None
_allow_download = False  # set by ``run`` once the user has agreed to the model download


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


def model_cache_dir() -> str:
    """Where Hugging Face keeps downloaded models (empty when huggingface_hub is missing)."""
    try:
        from huggingface_hub.constants import HF_HUB_CACHE  # noqa: PLC0415
    except ImportError:
        return ""
    return str(HF_HUB_CACHE)


def model_cached() -> bool:
    """True when the model weights are already on disk (no network involved)."""
    if not available():
        return False
    try:
        from huggingface_hub import try_to_load_from_cache  # noqa: PLC0415
    except ImportError:
        return False
    for name in ("model.safetensors", "pytorch_model.bin"):
        if isinstance(try_to_load_from_cache(MODEL_ID, name), str):
            return True
    return False


def model_ready() -> bool:
    """The detector can run without downloading anything (a test backend counts as ready)."""
    return _backend is not None or model_cached()


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
    offline = not _allow_download  # never download behind the user's back
    try:
        processor = OwlViTProcessor.from_pretrained(MODEL_ID, local_files_only=offline)
        model = OwlViTForObjectDetection.from_pretrained(MODEL_ID, local_files_only=offline)
    except OSError as exc:
        if offline:
            raise DetectorError(
                f"The detector model ({MODEL_ID}) is not downloaded yet; confirm the download first."
            ) from exc
        raise DetectorError(f"Could not download the detector model: {exc}") from exc
    model = model.to(device).eval()
    if device == "cuda" and HALF:
        model = model.half()
    return torch, processor, model, device


_query_cache: dict[bytes, object] = {}  # exemplar crops -> their query embeddings (they do not change during a run)


def _query_embeds(queries: list[np.ndarray]):
    """One query embedding per exemplar, encoded once and kept while the same exemplars are used."""
    from PIL import Image  # noqa: PLC0415

    torch, processor, model, device = _load_owl()
    key = hashlib.sha1(b"".join(q.tobytes() + repr(q.shape).encode() for q in queries)).digest() + bytes([HALF])
    if key not in _query_cache:
        if len(_query_cache) > 8:
            _query_cache.clear()
        embeds = []
        with torch.no_grad():
            for q in queries:
                image = Image.fromarray(cv2.cvtColor(q, cv2.COLOR_BGR2RGB))
                pv = processor(images=image, return_tensors="pt")["pixel_values"].to(device, model.dtype)
                fmap = model.image_embedder(pixel_values=pv)[0]
                feats = torch.reshape(fmap, (1, fmap.shape[1] * fmap.shape[2], fmap.shape[3]))
                embeds.append(model.embed_image_query(feats, fmap)[0])
        _query_cache[key] = embeds
    return _query_cache[key]


def _boxes_above_nms(scores: np.ndarray, boxes: np.ndarray) -> np.ndarray:
    """Greedy non-maximum suppression as the model's post-processing does it: best first, each kept box zeroes the
    scores of the boxes overlapping it by more than ``_QUERY_NMS``. Returns the scores left (0 = suppressed)."""
    scores = scores.copy()
    area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    for i in np.argsort(-scores, kind="stable"):
        if not scores[i]:
            continue
        iw = np.clip(np.minimum(boxes[i, 2], boxes[:, 2]) - np.maximum(boxes[i, 0], boxes[:, 0]), 0, None)
        ih = np.clip(np.minimum(boxes[i, 3], boxes[:, 3]) - np.maximum(boxes[i, 1], boxes[:, 1]), 0, None)
        inter = iw * ih
        iou = inter / (area[i] + area - inter)
        iou[i] = -1.0
        scores[iou > _QUERY_NMS] = 0.0
    return scores


def _owl_backend_batch(targets: list[np.ndarray], queries: list[np.ndarray], topk: int) -> list[list[tuple[dict, float]]]:
    """The default backend for several frames at once: each frame is encoded once and matched against every
    exemplar, whose embeddings were encoded once for the whole run."""
    from PIL import Image  # noqa: PLC0415

    torch, processor, model, device = _load_owl()
    embeds = _query_embeds(queries)
    images = [Image.fromarray(cv2.cvtColor(t, cv2.COLOR_BGR2RGB)) for t in targets]
    pv = processor(images=images, return_tensors="pt")["pixel_values"].to(device, model.dtype)
    with torch.no_grad():
        fmap = model.image_embedder(pixel_values=pv)[0]
        n, hh, ww, dim = fmap.shape
        feats = torch.reshape(fmap, (n, hh * ww, dim))
        centre = model.box_predictor(feats, fmap).float().cpu().numpy()  # (frames, patches, cx cy w h)
        logits = [model.class_predictor(image_feats=feats, query_embeds=e.expand(n, -1, -1))[0].float().max(dim=-1).values.cpu().numpy()
                  for e in embeds]  # per exemplar: (frames, patches)
    corners = np.stack([centre[..., 0] - centre[..., 2] / 2, centre[..., 1] - centre[..., 3] / 2,
                        centre[..., 0] + centre[..., 2] / 2, centre[..., 1] + centre[..., 3] / 2], axis=-1)
    out: list[list[tuple[dict, float]]] = []
    for f, target in enumerate(targets):
        height, width = target.shape[:2]
        found: list[tuple[dict, float]] = []
        for per_query in logits:
            scores = _boxes_above_nms(1.0 / (1.0 + np.exp(-per_query[f])), corners[f])  # single precision, as the model does: ties saturate at 1.0
            if not scores.any():
                continue
            top = scores.max() + 1e-6
            alpha = np.clip((scores - top * 0.1) / (top * 0.9), 0.0, 1.0)
            for i in np.flatnonzero(alpha > 0):
                x0, y0, x1, y1 = (float(v) for v in corners[f, i] * np.array([width, height, width, height], dtype=np.float32))
                x0, y0 = max(0.0, x0), max(0.0, y0)
                x1, y1 = min(float(width), x1), min(float(height), y1)
                if x1 > x0 and y1 > y0:
                    found.append(({"x": x0 / width, "y": y0 / height, "w": (x1 - x0) / width, "h": (y1 - y0) / height}, float(alpha[i])))
        out.append(merge(found, topk))
    return out


def _owl_backend(target: np.ndarray, queries: list[np.ndarray], topk: int):
    return _owl_backend_batch([target], queries, topk)[0]


_DEFAULT_BACKEND = _owl_backend  # ``run`` batches frames only while this one is in use


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


def run(
    camera: str,
    feature: str,
    report: Callable[[dict], None] = lambda _p: None,
    allow_download: bool = False,
) -> dict:
    """Detect the object in every frame of ``feature`` that no human has decided yet.

    The model is only downloaded when ``allow_download`` is set (the user confirmed it).
    """
    global _allow_download  # noqa: PLW0603
    _allow_download = allow_download
    settings = vision_settings.get(camera, feature)
    det = settings["detector"]
    if not det or not det["exemplars"]:
        raise DetectorError("Add at least one exemplar first")
    if _backend is None:
        if not model_cached():
            if not allow_download:
                raise DetectorError(
                    f"The detector model ({MODEL_ID}, about {MODEL_DOWNLOAD_MB} MB) is not downloaded; "
                    "confirm the download first."
                )
            report({"phase": "downloading"})
        _load_owl()  # loads (and, once confirmed, downloads) before the frame loop
    backend = _get_backend()
    queries = exemplar_crops(camera, feature, settings)
    sig = vision_settings.detection_signature(settings)
    roi = engine.resolve_roi(camera, feature)
    hmap = labels.hash_map(camera)
    frames = datamodel.frames_for_feature(camera, feature)
    detected = skipped = unreadable = needs_review = 0
    pending: list[tuple[str, np.ndarray]] = []  # (frame hash, crop) waiting for the next batch

    def flush() -> None:
        nonlocal detected, skipped, needs_review
        if not pending:
            return
        crops = [c for _, c in pending]
        if backend is _DEFAULT_BACKEND:
            results = _owl_backend_batch(crops, queries, det["topk"])
        else:  # a replacement backend (tests, other models) takes one frame at a time
            results = [backend(c, queries, det["topk"]) for c in crops]
        for (h, _), found in zip(pending, results):
            if not detections.save_auto(camera, feature, h, found, sig):
                skipped += 1
                continue
            detected += 1
            if not found or found[0][1] < det["threshold"]:
                needs_review += 1
        pending.clear()

    for i, frame in enumerate(frames):
        report({"done": i, "total": len(frames)})
        h = labels.frame_hash(camera, frame, hmap)
        try:
            crop = _filtered_crop(camera, roi, frame, settings)
        except FileNotFoundError:
            unreadable += 1
            continue
        pending.append((h, crop))
        if len(pending) >= BATCH:
            flush()
    flush()
    report({"done": len(frames), "total": len(frames)})
    vision_settings.purge_derived(camera, feature)
    return {"detected": detected, "skipped_human": skipped, "unreadable": unreadable,
            "needs_review": needs_review}
