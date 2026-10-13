r"""Compare incremental decoded-vector memory for retained versus streamed scoring.

The fixture and SQLite database live in a temporary directory. The measurement
starts after compact cache blobs have been prepared, isolating the decoded
float32 arrays that Phase 4 bounds.

Run from the project root::

    .\.venv\Scripts\python.exe app\backend\benchmark_vector_memory.py
"""
from __future__ import annotations

import argparse
import gc
import json
import os
import sys
import tempfile
import tracemalloc
from pathlib import Path


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", type=int, default=192)
    parser.add_argument("--goldens", type=int, default=6)
    parser.add_argument("--size", type=int, default=160)
    parser.add_argument("--batch-size", type=int, default=32)
    return parser.parse_args()


def _peak_decode_bytes(decode):
    gc.collect()
    tracemalloc.start()
    value = decode()
    _current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    del value
    gc.collect()
    return peak


def main() -> int:
    args = _arguments()
    if args.frames < args.goldens or args.goldens < 1:
        raise SystemExit("--frames must be at least --goldens, which must be positive")

    scripts_dir = Path(__file__).resolve().parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    with tempfile.TemporaryDirectory(prefix="picture-sorter-memory-") as tmp:
        root = Path(tmp)
        os.environ["CURATION_CAMERAS_ROOT"] = str(root / "cameras")
        os.environ["CURATION_DATA_DIR"] = str(root / "data")

        import cv2
        import numpy as np

        import classify
        import config
        import db
        import perf
        from benchmark_performance import _create_images
        from roi import ROI

        config.EMBEDDING_ENABLED = False
        config.SCORING_VECTOR_BATCH_SIZE = max(1, args.batch_size)
        camera = "synthetic-camera"
        feature = "inspection"
        names = _create_images(
            config.CAMERAS_ROOT / camera, args.frames, args.size, cv2, np
        )
        hmap = {frame: f"hash-{i:06d}" for i, frame in enumerate(names)}
        roi = ROI.full_frame(feature)
        con = db.connect()
        try:
            with perf.trace("memory-cache-prepare", enabled=False, emit=False):
                prepared = classify._prepare_vector_cache(
                    con,
                    camera,
                    feature,
                    classify._roi_cache_key(roi),
                    roi,
                    names,
                    hmap,
                    [],
                )
        finally:
            con.close()

        retained_peak = _peak_decode_bytes(
            lambda: classify._decode_vectors(prepared, names)
        )
        golden_frames = names[: args.goldens]
        candidate_frames = names[args.goldens :]

        def decode_streamed():
            goldens = classify._decode_vectors(prepared, golden_frames)
            checksum = 0.0
            for batch in classify._chunks(candidate_frames, args.batch_size):
                vectors = classify._decode_vectors(prepared, batch)
                checksum += sum(float(v["gray"][0, 0]) for v in vectors.values())
                del vectors
            return goldens, checksum

        streamed_peak = _peak_decode_bytes(decode_streamed)
        reduction = 1.0 - streamed_peak / retained_peak
        print(json.dumps({
            "fixture": {
                "frames": args.frames,
                "goldens": args.goldens,
                "image_size": args.size,
                "standard_gray_size": list(config.STANDARD_SIZE),
                "candidate_batch_size": args.batch_size,
                "storage": "TemporaryDirectory",
                "measurement": "incremental Python allocations after compact cache preparation",
            },
            "retain_all_peak_mib": round(retained_peak / 1024 / 1024, 3),
            "streamed_peak_mib": round(streamed_peak / 1024 / 1024, 3),
            "peak_reduction_percent": round(reduction * 100, 1),
        }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
