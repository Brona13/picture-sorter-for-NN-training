"""Measure scored-result cache serialization and persistence safely.

The benchmark constructs FrameScore objects in memory and stores them only in a
temporary SQLite database. It also measures compact/compressed candidates for
the Phase 9 decision gate without changing the production cache format.
"""

from __future__ import annotations

import json
import statistics
import tempfile
import time
import zlib
from pathlib import Path

import classify
import config
import db


SCENARIOS = (
    (48, 2, 1),
    (300, 2, 3),
    (1000, 4, 3),
)
REPETITIONS = 15


def _results(frame_count: int, class_count: int, method_count: int) -> list[classify.FrameScore]:
    classes = [f"class-{index}" for index in range(class_count)]
    methods = ["cpu", "resnet18", "resnet50"][:method_count]
    results: list[classify.FrameScore] = []
    for frame_index in range(frame_count):
        if frame_index % 20 == 0:
            results.append(
                classify.FrameScore(
                    frame=f"frame_{frame_index:06d}.png",
                    golden=classes[frame_index % class_count],
                )
            )
            continue
        frame = classify.FrameScore(frame=f"frame_{frame_index:06d}.png", golden=None)
        for method_index, method in enumerate(methods):
            distances = {
                cls: ((frame_index * 37 + class_index * 101 + method_index * 17) % 10000)
                / 10000.0
                for class_index, cls in enumerate(classes)
            }
            ranked = sorted(distances.items(), key=lambda item: item[1])
            frame.per_method[method] = classify.MethodScore(
                dists=distances,
                leaning=ranked[0][0],
                margin=ranked[1][1] - ranked[0][1] if len(ranked) > 1 else None,
                novelty=ranked[0][1],
            )
        results.append(frame)
    return results


def _jsonable(results: list[classify.FrameScore]) -> list[dict]:
    """Mirror the current public JSON shape for format-candidate measurements."""
    return [
        {
            "frame": result.frame,
            "golden": result.golden,
            "per_method": {
                method: {
                    "dists": score.dists,
                    "leaning": score.leaning,
                    "margin": score.margin,
                    "novelty": score.novelty,
                }
                for method, score in result.per_method.items()
            },
        }
        for result in results
    ]


def _median_ms(function, repetitions: int = REPETITIONS):
    timings: list[float] = []
    value = None
    for _ in range(repetitions):
        started = time.perf_counter()
        value = function()
        timings.append((time.perf_counter() - started) * 1_000.0)
    return statistics.median(timings), value


def _scenario(frame_count: int, class_count: int, method_count: int) -> dict[str, object]:
    results = _results(frame_count, class_count, method_count)
    serialize_ms, current_blob = _median_ms(lambda: classify.serialise_results(results))
    deserialize_ms, decoded = _median_ms(lambda: classify.deserialise_results(current_blob))
    if classify.serialise_results(decoded) != current_blob:
        raise RuntimeError("JSON round trip changed the payload")

    compact_ms, compact_blob = _median_ms(
        lambda: json.dumps(_jsonable(results), separators=(",", ":")).encode("utf-8")
    )
    compressed_serialize_ms, compressed_blob = _median_ms(
        lambda: zlib.compress(
            json.dumps(_jsonable(results), separators=(",", ":")).encode("utf-8"),
            level=6,
        )
    )
    compressed_deserialize_ms, compressed_results = _median_ms(
        lambda: classify.deserialise_results(zlib.decompress(compressed_blob))
    )
    if classify.serialise_results(compressed_results) != current_blob:
        raise RuntimeError("compressed candidate round trip changed scored results")

    feature = f"f-{frame_count}-{class_count}-{method_count}"
    db.save_results("benchmark-camera", feature, "roi", "gold", "frames", current_blob)
    save_ms, _ = _median_ms(
        lambda: db.save_results(
            "benchmark-camera", feature, "roi", "gold", "frames", current_blob,
        )
    )
    load_ms, row = _median_ms(
        lambda: db.load_results("benchmark-camera", feature, "roi")
    )
    if row is None or row["payload"] != current_blob:
        raise RuntimeError("SQLite result-cache round trip changed the payload")

    compressed_feature = feature + "-compressed"
    db.save_results(
        "benchmark-camera", compressed_feature, "roi", "gold", "frames", compressed_blob,
    )
    compressed_save_ms, _ = _median_ms(
        lambda: db.save_results(
            "benchmark-camera",
            compressed_feature,
            "roi",
            "gold",
            "frames",
            compressed_blob,
        )
    )
    compressed_load_ms, compressed_row = _median_ms(
        lambda: db.load_results("benchmark-camera", compressed_feature, "roi")
    )
    if compressed_row is None or compressed_row["payload"] != compressed_blob:
        raise RuntimeError("SQLite compressed-candidate round trip changed the payload")

    return {
        "frames": frame_count,
        "classes": class_count,
        "methods": method_count,
        "json_bytes": len(current_blob),
        "compact_json_bytes": len(compact_blob),
        "zlib_compact_bytes": len(compressed_blob),
        "serialize_ms": round(serialize_ms, 3),
        "deserialize_ms": round(deserialize_ms, 3),
        "sqlite_save_ms": round(save_ms, 3),
        "sqlite_load_ms": round(load_ms, 3),
        "refresh_persistence_ms": round(serialize_ms + save_ms, 3),
        "cache_hydration_ms": round(load_ms + deserialize_ms, 3),
        "compact_serialize_ms": round(compact_ms, 3),
        "compressed_serialize_ms": round(compressed_serialize_ms, 3),
        "compressed_deserialize_ms": round(compressed_deserialize_ms, 3),
        "compressed_sqlite_save_ms": round(compressed_save_ms, 3),
        "compressed_sqlite_load_ms": round(compressed_load_ms, 3),
        "compressed_refresh_persistence_ms": round(
            compressed_serialize_ms + compressed_save_ms, 3
        ),
        "compressed_cache_hydration_ms": round(
            compressed_load_ms + compressed_deserialize_ms, 3
        ),
        "compact_reduction_pct": round((1 - len(compact_blob) / len(current_blob)) * 100, 1),
        "compressed_reduction_pct": round(
            (1 - len(compressed_blob) / len(current_blob)) * 100, 1
        ),
    }


def run() -> dict[str, object]:
    old_data = config.DATA_DIR
    try:
        with tempfile.TemporaryDirectory(prefix="picture-sorter-results-cache-") as temp_dir:
            config.DATA_DIR = Path(temp_dir) / "data"
            scenarios = [_scenario(*values) for values in SCENARIOS]
            con = db.connect()
            try:
                stored_payload_bytes = con.execute(
                    "SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM results_cache"
                ).fetchone()[0]
            finally:
                con.close()
            database_bytes = (config.DATA_DIR / "picture_sorter.db").stat().st_size
            return {
                "repetitions": REPETITIONS,
                "storage": "TemporaryDirectory",
                "scenarios": scenarios,
                "stored_payload_bytes": stored_payload_bytes,
                "database_file_bytes": database_bytes,
            }
    finally:
        config.DATA_DIR = old_data


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
