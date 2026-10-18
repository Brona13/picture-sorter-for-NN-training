"""Benchmark the Detector page's OWL-ViT backend on synthetic 250 x 250 frames (no cameras or database involved).

    python app/backend/benchmark_detector.py [--frames 48] [--exemplars 3] [--batch 8]

Variants: ``baseline`` is the original implementation (one full image-guided pass per frame and exemplar, with the model's
own Python post-processing); the others are the current backend in single precision or half precision, one frame at a
time or in batches. Each is timed warm (the first batch is a warm-up) and compared with the baseline's boxes so a speedup is
not bought with different detections. The model must already be downloaded.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detector  # noqa: E402


def baseline(target: np.ndarray, queries: list[np.ndarray], topk: int):
    """The backend as it was before the speed-up: every exemplar is a separate full pass, post-processed by the model."""
    from PIL import Image  # noqa: PLC0415

    torch, processor, model, device = detector._load_owl()
    height, width = target.shape[:2]
    image = Image.fromarray(cv2.cvtColor(target, cv2.COLOR_BGR2RGB))
    found: list[tuple[dict, float]] = []
    for query in queries:
        query_image = Image.fromarray(cv2.cvtColor(query, cv2.COLOR_BGR2RGB))
        inputs = processor(images=image, query_images=query_image, return_tensors="pt").to(device)
        with torch.no_grad():
            outputs = model.image_guided_detection(**inputs)
        sizes = torch.tensor([[height, width]], device=device)
        result = processor.post_process_image_guided_detection(outputs=outputs, threshold=0.0, nms_threshold=0.3, target_sizes=sizes)[0]
        for (x0, y0, x1, y1), score in zip(result["boxes"].tolist(), result["scores"].tolist()):
            x0, y0 = max(0.0, x0), max(0.0, y0)
            x1, y1 = min(float(width), x1), min(float(height), y1)
            if x1 > x0 and y1 > y0:
                found.append(({"x": x0 / width, "y": y0 / height, "w": (x1 - x0) / width, "h": (y1 - y0) / height}, float(score)))
    return detector.merge(found, topk)


def synthetic_frames(n: int, size: int = 250, seed: int = 0) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    frames = []
    for _ in range(n):
        img = np.full((size, size, 3), rng.integers(60, 200), dtype=np.uint8)
        for _ in range(4):
            x, y = rng.integers(10, size - 80, size=2)
            w, h = rng.integers(30, 70, size=2)
            cv2.rectangle(img, (int(x), int(y)), (int(x + w), int(y + h)), [int(c) for c in rng.integers(0, 255, 3)], -1)
        frames.append(img)
    return frames


def iou(a: dict, b: dict) -> float:
    return detector._iou(a, b)


def reset(half: bool) -> None:
    detector.HALF = half
    detector._load_owl.cache_clear()
    detector._query_cache.clear()


def timed(fn, frames: list[np.ndarray], batch: int):
    """Warm up on the first batch, then time the rest; returns (frames per second, all results in order)."""
    out = list(fn(frames[:batch]))
    start = time.perf_counter()
    for i in range(batch, len(frames), batch):
        out.extend(fn(frames[i : i + batch]))
    elapsed = time.perf_counter() - start
    return (len(frames) - batch) / elapsed, out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=48)
    ap.add_argument("--exemplars", type=int, default=3)
    ap.add_argument("--batch", type=int, default=8)
    args = ap.parse_args()
    if not detector.model_cached():
        sys.exit("The detector model is not downloaded; run a detection in the app once to download it.")

    frames = synthetic_frames(args.frames)
    queries = [f[40:100, 40:100].copy() for f in synthetic_frames(args.exemplars, seed=7)]
    topk = 2
    import torch  # noqa: PLC0415

    print(f"torch {torch.__version__}  device {'cuda' if torch.cuda.is_available() else 'cpu'}  frames {args.frames}  exemplars {args.exemplars}  batch {args.batch}")

    variants = [
        ("baseline (fp32, per exemplar, one frame)", False, 1, lambda fs: [baseline(f, queries, topk) for f in fs]),
        ("new, fp32, one frame at a time", False, 1, lambda fs: [detector._owl_backend(f, queries, topk) for f in fs]),
        ("new, fp16, one frame at a time", True, 1, lambda fs: [detector._owl_backend(f, queries, topk) for f in fs]),
        (f"new, fp32, batches of {args.batch}", False, args.batch, lambda fs: detector._owl_backend_batch(fs, queries, topk)),
        (f"new, fp16, batches of {args.batch}", True, args.batch, lambda fs: detector._owl_backend_batch(fs, queries, topk)),
    ]
    reference = None
    print(f"{'variant':44s} {'frames/s':>9s} {'speed-up':>9s} {'top-1 IoU vs baseline (min / mean)':>38s} {'score diff (max)':>17s}")
    base_fps = None
    for name, half, batch, fn in variants:
        reset(half)
        fps, out = timed(fn, frames, batch)
        if reference is None:
            reference, base_fps = out, fps
            print(f"{name:44s} {fps:9.2f} {1.0:9.2f} {'-':>38s} {'-':>17s}")
            continue
        ious = [iou(a[0][0], b[0][0]) if a and b else 0.0 for a, b in zip(reference, out)]
        dscore = max((abs(a[0][1] - b[0][1]) for a, b in zip(reference, out) if a and b), default=0.0)
        print(f"{name:44s} {fps:9.2f} {fps / base_fps:9.2f} {min(ious):17.4f} / {np.mean(ious):.4f} {dscore:17.4f}")


if __name__ == "__main__":
    main()
