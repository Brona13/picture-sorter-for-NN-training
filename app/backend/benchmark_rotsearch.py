"""Benchmark the rotation-aware search (``rotsearch``) on synthetic pictures with a known planted pattern.

    python app/backend/benchmark_rotsearch.py [--frames 40] [--size 250] [--noise 6] [--seed 0]

Each picture is a textured background with an asymmetric pattern (a disc with a notch and a nearby triangle, so the
pattern has a clear orientation) planted at a random position and rotation, with noise. The pattern's own position and
angle are known, so the report shows how far the search is off, and how long it takes. No cameras or database involved.
Synthetic pictures only: it says nothing yet about real camera frames.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rotsearch  # noqa: E402


def pattern(size: int = 64) -> np.ndarray:
    """An asymmetric grey pattern on a mid-grey square: a dark disc with a bright notch, plus a triangle at one side."""
    img = np.full((size, size), 140, np.uint8)
    cv2.circle(img, (size // 2 - 6, size // 2), size // 4, 40, -1)
    cv2.circle(img, (size // 2 - 6 + size // 6, size // 2 - size // 10), size // 12, 220, -1)  # notch
    triangle = np.array([[size - 14, size // 2 - 10], [size - 4, size // 2], [size - 14, size // 2 + 10]], np.int32)
    cv2.fillPoly(img, [triangle], 230)
    return img


def plant(background: np.ndarray, example: np.ndarray, cx: float, cy: float, angle: float) -> np.ndarray:
    """Paste ``example`` turned by ``angle`` (counter-clockwise on screen) so its centre lands on ``(cx, cy)``."""
    h, w = example.shape[:2]
    m = cv2.getRotationMatrix2D(((w - 1) / 2.0, (h - 1) / 2.0), angle, 1.0)
    m[0, 2] += cx - (w - 1) / 2.0
    m[1, 2] += cy - (h - 1) / 2.0
    turned = cv2.warpAffine(example, m, (background.shape[1], background.shape[0]), flags=cv2.INTER_LINEAR, borderValue=0)
    inside = cv2.warpAffine(np.full((h, w), 255, np.uint8), m, (background.shape[1], background.shape[0]), flags=cv2.INTER_LINEAR, borderValue=0)
    out = background.astype(np.float32)
    alpha = (inside.astype(np.float32) / 255.0)
    return (out * (1 - alpha) + turned.astype(np.float32) * alpha).astype(np.uint8)


def background(size: int, rng: np.random.Generator) -> np.ndarray:
    img = cv2.GaussianBlur(rng.integers(60, 200, (size, size), dtype=np.uint8), (0, 0), 3)
    return img


def angle_error(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=40)
    ap.add_argument("--size", type=int, default=250)
    ap.add_argument("--noise", type=float, default=6.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--example", type=int, default=64)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    example = pattern(args.example)
    errors_xy, errors_angle, times, scores = [], [], [], []
    missed = 0
    margin = 60
    for _ in range(args.frames):
        cx, cy = rng.uniform(margin, args.size - margin, 2)
        angle = rng.uniform(0, 360)
        frame = plant(background(args.size, rng), example, cx, cy, angle)
        frame = np.clip(frame.astype(np.float32) + rng.normal(0, args.noise, frame.shape), 0, 255).astype(np.uint8)
        t0 = time.perf_counter()
        match = rotsearch.find(frame, example)
        times.append(time.perf_counter() - t0)
        if match is None:
            missed += 1
            continue
        errors_xy.append(float(np.hypot(match.x - cx, match.y - cy)))
        errors_angle.append(angle_error(match.angle, angle))
        scores.append(match.score)
    def stat(values):
        return f"mean {np.mean(values):.3f}  p95 {np.percentile(values, 95):.3f}  max {np.max(values):.3f}" if values else "n/a"
    print(f"{args.frames} synthetic {args.size}x{args.size} pictures, noise sd {args.noise}, example {example.shape[1]}x{example.shape[0]}")
    print(f"not found: {missed}")
    print(f"centre error (px):   {stat(errors_xy)}")
    print(f"angle error (deg):   {stat(errors_angle)}")
    print(f"score:               {stat(scores)}")
    print(f"time per picture:    {np.mean(times) * 1000:.0f} ms (mean), {np.max(times) * 1000:.0f} ms (max)")


if __name__ == "__main__":
    main()
