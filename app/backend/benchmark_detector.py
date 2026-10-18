"""Benchmark the Detector page's OWL-ViT backend on synthetic 250 x 250 frames (no cameras or database involved).

    python app/backend/benchmark_detector.py [--frames 64] [--batch 8] [--photos]

Variants: ``baseline`` is the original implementation (its boxes have the model\'s own size, not the exemplar\'s) (one full image-guided pass per frame and exemplar, with the model's
own Python post-processing); the others are the current backend at the model's own size (768) or the faster 512, in single
or half precision, one frame at a time or in batches. Each is timed warm (the first batch is a warm-up) and compared with
the baseline's boxes, and with a planted object whose position is known, so a speedup is not bought with worse detections.
The model must already be downloaded.
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


def object_image(size: int) -> np.ndarray:
    """A distinctive pattern: the object the exemplars show and that is planted in the frames."""
    im = np.full((size, size, 3), 90, np.uint8)
    c = size // 2
    cv2.circle(im, (c, c), c - 2, (30, 30, 220), -1)
    cv2.circle(im, (c, c), c // 2, (220, 200, 40), -1)
    cv2.line(im, (c, 4), (c, size - 4), (255, 255, 255), 3)
    cv2.line(im, (4, c), (size - 4, c), (255, 255, 255), 3)
    return im


def planted_frames(n: int, seed: int = 0) -> tuple[list[np.ndarray], list[dict]]:
    """Frames with distractor rectangles and the object planted at a known place: (frames, true boxes)."""
    rng = np.random.default_rng(seed)
    frames, truth = [], []
    for _ in range(n):
        img = np.full((250, 250, 3), int(rng.integers(60, 200)), np.uint8)
        for _ in range(4):
            x, y = rng.integers(10, 170, 2)
            w, h = rng.integers(30, 70, 2)
            cv2.rectangle(img, (int(x), int(y)), (int(x + w), int(y + h)), [int(c) for c in rng.integers(0, 255, 3)], -1)
        side = 60  # series production: the object always has the same size
        x, y = (int(v) for v in rng.integers(5, 250 - side - 5, 2))
        img[y : y + side, x : x + side] = object_image(side)
        frames.append(img)
        truth.append({"x": x / 250, "y": y / 250, "w": side / 250, "h": side / 250})
    return frames, truth


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


def shifted_photos(frames_per_scene: int = 24) -> None:
    """Template matching against the model on shifted, brightness-jittered copies of real photographs (series production:
    the same picture, the object moved a little). The exemplar is a square cut from the middle; the truth is where it went."""
    from skimage import data  # noqa: PLC0415

    scenes = {"astronaut": data.astronaut(), "coffee": data.coffee(), "chelsea (cat)": data.chelsea(), "rocket": data.rocket()}
    rng = np.random.default_rng(1)
    print(f"\n{'scene':14s} {'exemplar':>8s} | {'template: found':>15s} {'centre err px':>13s} {'ms/frame':>8s} | {'model: found':>12s} {'centre err px':>13s} {'ms/frame':>8s}")
    reset(False)
    for name, photo in scenes.items():
        img = cv2.resize(photo, (250, 250))[:, :, ::-1].copy()
        for frac in (0.2, 0.3):
            side = int(250 * frac)
            x0 = y0 = (250 - side) // 2
            query = img[y0 : y0 + side, x0 : x0 + side].copy()
            targets, truth = [], []
            for _ in range(frames_per_scene):
                dx, dy = (int(v) for v in rng.integers(-12, 13, 2))
                moved = cv2.warpAffine(img, np.float32([[1, 0, dx], [0, 1, dy]]), (250, 250), borderMode=cv2.BORDER_REFLECT)
                targets.append(np.clip(moved.astype(np.float32) * rng.uniform(0.9, 1.1) + rng.normal(0, 3, moved.shape), 0, 255).astype(np.uint8))
                truth.append({"x": (x0 + dx) / 250, "y": (y0 + dy) / 250, "w": side / 250, "h": side / 250})
            row = []
            for fn in (lambda ts: [detector._template_backend(t, [query], 1) for t in ts], lambda ts: detector._owl_backend_batch(ts, [query], 1)):
                fn(targets[:4])  # warm up
                start = time.perf_counter()
                out = fn(targets)
                ms = (time.perf_counter() - start) / len(targets) * 1000
                hits = [bool(r) and iou(r[0][0], t) >= 0.5 for r, t in zip(out, truth)]
                err = [np.hypot((r[0][0]["x"] - t["x"]) * 250, (r[0][0]["y"] - t["y"]) * 250) for r, t in zip(out, truth) if r]
                row.append((float(np.mean(hits)), float(np.median(err)) if err else float("nan"), ms))
            print(f"{name:14s} {frac * 100:7.0f}% | {row[0][0]:15.0%} {row[0][1]:13.1f} {row[0][2]:8.1f} | {row[1][0]:12.0%} {row[1][1]:13.1f} {row[1][2]:8.1f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=64)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--photos", action="store_true", help="also compare template matching with the model on shifted real photographs (needs scikit-image)")
    args = ap.parse_args()
    if not detector.model_cached():
        sys.exit("The detector model is not downloaded; run a detection in the app once to download it.")

    frames, truth = planted_frames(args.frames)
    queries = [object_image(60)] * 3
    topk = 2
    import torch  # noqa: PLC0415

    print(f"torch {torch.__version__}  device {'cuda' if torch.cuda.is_available() else 'cpu'}  frames {args.frames}  exemplars {len(queries)}  batch {args.batch}")

    def batched(size: int):
        return lambda fs: detector._owl_backend_batch(fs, queries, topk, size)

    variants = [
        ("baseline (original code)", False, 1, lambda fs: [baseline(f, queries, topk) for f in fs]),
        ("template matching", False, 1, lambda fs: [detector._template_backend(f, queries, topk) for f in fs]),
        ("current, 768 (default)", False, args.batch, batched(768)),
        ("current, 512 (faster option)", False, args.batch, batched(512)),
        ("current, 768, half precision", True, args.batch, batched(768)),
        ("current, 512, half precision", True, args.batch, batched(512)),
    ]
    print(f"{'variant':32s} {'frames/s':>9s} {'speed-up':>9s} {'found (top-1 IoU>=.5)':>22s} {'mean IoU':>9s} {'centre error px (median)':>25s}")
    base_fps = None
    for name, half, batch, fn in variants:
        reset(half)
        fps, out = timed(fn, frames, batch)
        ious = [iou(r[0][0], t) if r else 0.0 for r, t in zip(out, truth)]
        found = float(np.mean([i >= 0.5 for i in ious]))
        base_fps = base_fps or fps
        centre = float(np.median([np.hypot((r[0][0]["x"] + r[0][0]["w"] / 2 - t["x"] - t["w"] / 2) * 250, (r[0][0]["y"] + r[0][0]["h"] / 2 - t["y"] - t["h"] / 2) * 250) if r else 250 for r, t in zip(out, truth)]))
        print(f"{name:32s} {fps:9.2f} {fps / base_fps:9.2f} {found:22.0%} {np.mean(ious):9.2f} {centre:25.1f}")
    if args.photos:
        shifted_photos()


if __name__ == "__main__":
    main()
