"""Measure folder-ingest time and Python peak memory with synthetic files.

All source files, camera storage, and SQLite frame catalogs live under one temporary
directory. The configured project camera root is never read or written.
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time
import tracemalloc
from pathlib import Path

import config
import ingest


def _create_sources(root: Path, count: int, bytes_per_file: int) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        header = index.to_bytes(8, "little")
        payload = header + bytes([index % 251]) * max(0, bytes_per_file - len(header))
        (root / f"frame_{index:04d}.jpg").write_bytes(payload)


def run(count: int, bytes_per_file: int) -> dict[str, object]:
    old_data = config.DATA_DIR
    old_cameras = config.CAMERAS_ROOT
    try:
        with tempfile.TemporaryDirectory(prefix="picture-sorter-ingest-") as temp_dir:
            root = Path(temp_dir)
            source = root / "source"
            config.DATA_DIR = root / "data"
            config.CAMERAS_ROOT = root / "cameras"
            _create_sources(source, count, bytes_per_file)

            progress_events: list[dict[str, object]] = []

            def progress(update) -> None:
                progress_events.append(
                    {
                        "phase": update.phase,
                        "done": update.done,
                        "total": update.total,
                    }
                )

            callback = progress if "progress_cb" in ingest.ingest_folder.__code__.co_varnames else None
            tracemalloc.start()
            started = time.perf_counter()
            if callback is None:
                result = ingest.ingest_folder("benchmark-camera", "unsorted", source)
            else:
                result = ingest.ingest_folder(
                    "benchmark-camera", "unsorted", source, progress_cb=callback,
                )
            elapsed_ms = (time.perf_counter() - started) * 1_000.0
            _current, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()

            return {
                "files": count,
                "bytes_per_file": bytes_per_file,
                "source_bytes": count * bytes_per_file,
                "elapsed_ms": round(elapsed_ms, 3),
                "peak_python_bytes": peak,
                "added": result.n_added,
                "skipped": result.n_skipped,
                "errors": len(result.errors),
                "progress_events": len(progress_events),
                "progress_phases": sorted({row["phase"] for row in progress_events}),
            }
    finally:
        config.DATA_DIR = old_data
        config.CAMERAS_ROOT = old_cameras


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--files", type=int, default=48)
    parser.add_argument("--mib-per-file", type=int, default=1)
    args = parser.parse_args()
    print(json.dumps(run(args.files, args.mib_per_file * 1024 * 1024), indent=2))


if __name__ == "__main__":
    main()
