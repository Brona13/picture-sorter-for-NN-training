r"""Safe synthetic baseline for the performance-improvement plan.

This script always creates its own temporary camera and data roots before it
imports the application modules.  It cannot be pointed at production storage.

Run from the project root::

    .\.venv\Scripts\python.exe scripts\benchmark_performance.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", type=int, default=48)
    parser.add_argument("--size", type=int, default=160, help="Synthetic square image size")
    parser.add_argument("--comparison-workers", type=int)
    parser.add_argument("--vector-batch-size", type=int)
    return parser.parse_args()


def _create_images(camera_dir: Path, count: int, size: int, cv2, np) -> list[str]:
    unsorted = camera_dir / "unsorted"
    unsorted.mkdir(parents=True)
    names: list[str] = []
    yy, xx = np.mgrid[:size, :size]
    for i in range(count):
        base = (xx * 3 + yy * 2 + i * 11) % 256
        image = np.stack(
            [base, (base + i * 7) % 256, (255 - base + i * 3) % 256], axis=2
        ).astype(np.uint8)
        cv2.rectangle(
            image,
            (size // 5, size // 5),
            (size * 4 // 5, size * 4 // 5),
            (20 + i % 200, 100, 220),
            2,
        )
        name = f"frame_{i:04d}.png"
        if not cv2.imwrite(str(unsorted / name), image):
            raise RuntimeError(f"could not write synthetic image {name}")
        names.append(name)
    return names


def _populate_state(camera: str, feature: str, names: list[str], labels) -> None:
    """Establish deterministic direct state for the synthetic fixture."""
    for i, name in enumerate(names):
        labels.set_label(camera, feature, name, "OK" if i % 2 == 0 else "NG", source="benchmark")

    for name in (names[:3] + names[3:6]):
        cls = "OK" if names.index(name) < 3 else "NG"
        labels.set_label(camera, feature, name, cls, source="benchmark-golden")
        labels.mark_golden(camera, feature, name, cls)


def _run_trace(perf, classify, camera: str, feature: str, label: str):
    with perf.trace(
        label,
        enabled=True,
        emit=False,
        camera=camera,
        feature=feature,
    ) as report:
        results = classify.refresh(camera, feature)
        payload = classify.serialise_results(results)
        classify.deserialise_results(payload)
    return report, results


def _simulate_grid_state_reads(perf, labels, db, camera: str, feature: str, names: list[str]):
    """Reproduce the optimized full-render state reads without Streamlit."""
    visible = names[: min(24, len(names))]
    with perf.trace(
        "simulated_grid_state_reads",
        enabled=True,
        emit=False,
        camera=camera,
        feature=feature,
        visible_cards=len(visible),
    ) as report:
        label_state = labels.current_labels(camera, feature)
        golden_state = labels.current_goldens(camera, feature)
        deleted = db.deleted_frames_of(camera)
        for frame in visible:
            label_state.get(frame)
            labels.golden_class_of(golden_state, frame)
            frame in deleted
            perf.count("grid.cards_simulated")
    return report


def main() -> int:
    args = _arguments()
    if args.frames < 8:
        raise SystemExit("--frames must be at least 8")
    if args.size < 32:
        raise SystemExit("--size must be at least 32")

    scripts_dir = Path(__file__).resolve().parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    with tempfile.TemporaryDirectory(prefix="picture-sorter-benchmark-") as tmp:
        root = Path(tmp)
        cameras_root = root / "cameras"
        data_root = root / "data"
        os.environ["CURATION_CAMERAS_ROOT"] = str(cameras_root)
        os.environ["CURATION_DATA_DIR"] = str(data_root)

        import cv2
        import numpy as np

        import classify
        import config
        import datamodel
        import db
        import labels
        import perf
        from roi import ROI

        # Phase 0 benchmarks the always-available classical path. Neural batching
        # gets its own controlled benchmark in Phase 3.
        config.EMBEDDING_ENABLED = False
        if args.comparison_workers is not None:
            config.CLASSICAL_COMPARISON_WORKERS = max(1, args.comparison_workers)
        if args.vector_batch_size is not None:
            config.SCORING_VECTOR_BATCH_SIZE = max(1, args.vector_batch_size)

        camera = "synthetic-camera"
        feature = "inspection"
        camera_dir = cameras_root / camera
        names = _create_images(camera_dir, args.frames, args.size, cv2, np)
        datamodel.save_rois(camera, [ROI(feature, 0.1, 0.1, 0.8, 0.8)])
        _populate_state(camera, feature, names, labels)

        cold, cold_results = _run_trace(perf, classify, camera, feature, "cold_classical_refresh")
        warm, warm_results = _run_trace(perf, classify, camera, feature, "warm_classical_refresh")
        grid_state = _simulate_grid_state_reads(
            perf, labels, db, camera, feature, names
        )

        if len(cold_results) != len(warm_results):
            raise RuntimeError("cold and warm result lengths differ")
        cold_blob = classify.serialise_results(cold_results)
        warm_blob = classify.serialise_results(warm_results)
        if cold_blob != warm_blob:
            raise RuntimeError("cold and warm scoring results differ")

        output = {
            "fixture": {
                "frames": args.frames,
                "image_size": args.size,
                "storage": "TemporaryDirectory",
                "neural_enabled": False,
                "comparison_workers": config.CLASSICAL_COMPARISON_WORKERS,
                "vector_batch_size": config.SCORING_VECTOR_BATCH_SIZE,
            },
            "cold": cold.as_dict(),
            "warm": warm.as_dict(),
            "grid_state_reads": grid_state.as_dict(),
        }
        print(json.dumps(output, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
