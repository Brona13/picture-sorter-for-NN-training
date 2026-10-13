r"""Benchmark single-image versus bounded neural inference on synthetic images.

The model is loaded once before timing starts. No project images or database are
read or written.

Run from the project root::

    .\.venv\Scripts\python.exe app\backend\benchmark_embedding_batches.py
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--size", type=int, default=256)
    parser.add_argument("--backbone", default="resnet18")
    parser.add_argument("--batch-size", type=int)
    return parser.parse_args()


def _images(count: int, size: int) -> list[np.ndarray]:
    yy, xx = np.mgrid[:size, :size]
    images = []
    for i in range(count):
        base = (xx * 3 + yy * 5 + i * 17) % 256
        images.append(
            np.stack((base, (base + i * 9) % 256, (255 - base + i * 4) % 256), axis=2)
            .astype(np.uint8)
        )
    return images


def _timed(embedding, images, backbone: str, batch_size: int):
    started = time.perf_counter()
    vectors = embedding.embed_batch(images, backbone, batch_size=batch_size)
    return time.perf_counter() - started, np.stack(vectors)


def main() -> int:
    args = _arguments()
    if args.frames < 2 or args.size < 32:
        raise SystemExit("--frames must be at least 2 and --size at least 32")

    scripts_dir = Path(__file__).resolve().parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    import embedding

    if args.backbone not in embedding.backbones():
        raise SystemExit(f"embedding backbone is unavailable: {args.backbone}")

    images = _images(args.frames, args.size)
    device = embedding.active_device()
    batch_size = args.batch_size or embedding._configured_batch_size(device)

    # Load weights and perform one warm-up outside both measurements.
    embedding.get_model(args.backbone)
    embedding.embed_batch(images[:1], args.backbone, batch_size=1)
    single_seconds, single = _timed(embedding, images, args.backbone, 1)
    batch_seconds, batched = _timed(embedding, images, args.backbone, batch_size)
    max_abs_diff = float(np.max(np.abs(single - batched)))
    equivalent = bool(np.allclose(single, batched, rtol=1e-5, atol=1e-6))
    if not equivalent:
        raise RuntimeError(f"batched embeddings differ (max abs diff {max_abs_diff})")

    print(json.dumps({
        "fixture": {
            "frames": args.frames,
            "image_size": args.size,
            "backbone": args.backbone,
            "device": device,
            "batch_size": batch_size,
            "storage": "in-memory synthetic images",
        },
        "single_image_ms": round(single_seconds * 1000, 3),
        "batched_ms": round(batch_seconds * 1000, 3),
        "speedup": round(single_seconds / batch_seconds, 3),
        "max_absolute_difference": max_abs_diff,
        "equivalent": equivalent,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
