r"""Benchmark repeated Status-style filesystem, ROI, scope, and summary reads.

The benchmark constructs temporary camera and database roots and does not read
project data. It intentionally mirrors the data access performed by Status
without rendering Streamlit widgets.

Run from the project root::

    .\.venv\Scripts\python.exe app\backend\benchmark_render_data.py
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import tempfile
import time
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch


def _fixture(config, datamodel, db, ROI):
    camera = "status-camera"
    products = ["product-a", "product-b", "product-c", "product-d"]
    features = [ROI("product-sort", 0, 0, 1, 1, role="classify", classes=products)]
    for product in products:
        for i in range(3):
            features.append(ROI(f"{product}::quality-{i}", 0.1, 0.1, 0.8, 0.8))
    features.extend([
        ROI("shared-a", 0.1, 0.1, 0.8, 0.8, products=products[:3]),
        ROI("shared-b", 0.2, 0.2, 0.6, 0.6, products=products[1:]),
    ])
    datamodel.ensure_camera_dirs(camera)
    unsorted = datamodel.unsorted_dir(camera)
    names = [f"frame-{i:04d}.png" for i in range(500)]
    for name in names:
        (unsorted / name).touch()
    datamodel.save_rois(camera, features)

    con = db.connect()
    try:
        con.executemany(
            "INSERT INTO labels(camera,feature,frame,hash,class,source,updated) "
            "VALUES (?,?,?,?,?,'benchmark',0)",
            [(camera, "product-sort", name, "", products[i % 4]) for i, name in enumerate(names)],
        )
        for feature_index, roi in enumerate(features[1:], start=1):
            scoped = names[feature_index : feature_index + 120]
            con.executemany(
                "INSERT INTO labels(camera,feature,frame,hash,class,source,updated) "
                "VALUES (?,?,?,?,?,'benchmark',0)",
                [(camera, roi.name, name, "", "OK" if i % 2 else "NG") for i, name in enumerate(scoped)],
            )
            con.executemany(
                "INSERT INTO goldens(camera,feature,frame,hash,class,updated) "
                "VALUES (?,?,?,?,?,0)",
                [(camera, roi.name, scoped[0], "", "NG"), (camera, roi.name, scoped[1], "", "OK")],
            )
            con.execute(
                "INSERT INTO versions(camera,feature,number,name,created,active) "
                "VALUES (?,?,1,'baseline',0,1)",
                (camera, roi.name),
            )
        con.commit()
    finally:
        con.close()
    return camera


def _status_payload(camera, config, datamodel, labels, versions):
    unsorted = datamodel.list_unsorted(camera)
    rois = datamodel.load_rois(camera)
    products = datamodel.products(camera)
    feature_names = [roi.name for roi in rois]
    label_states, golden_states = labels.current_states_for_features(
        camera, feature_names
    )
    version_summaries = versions.summaries(camera, feature_names)
    rows = []
    for roi in rois:
        classes = list(roi.classes) if roi.classes else list(config.CLASSES)
        counts = labels.counts(
            camera,
            roi.name,
            label_state=label_states[roi.name],
            golden_state=golden_states[roi.name],
        )
        rows.append(
            (
                roi.name,
                tuple(classes),
                tuple(sorted(counts.items())),
                version_summaries[roi.name]["count"],
            )
        )
    return len(unsorted), len(rois), tuple(products), tuple(rows)


def main() -> int:
    scripts_dir = Path(__file__).resolve().parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    with tempfile.TemporaryDirectory(prefix="picture-sorter-render-data-") as tmp:
        root = Path(tmp)
        os.environ["CURATION_CAMERAS_ROOT"] = str(root / "cameras")
        os.environ["CURATION_DATA_DIR"] = str(root / "data")
        import config
        import datamodel
        import db
        import labels
        import perf
        import versions
        from roi import ROI

        camera = _fixture(config, datamodel, db, ROI)
        originals = {
            name: getattr(datamodel, name)
            for name in ("load_rois", "list_unsorted", "frames_of_product", "frames_for_feature")
        }
        timings = []
        payload = None
        with (
            patch.object(datamodel, "load_rois", wraps=originals["load_rois"]) as load_rois,
            patch.object(datamodel, "list_unsorted", wraps=originals["list_unsorted"]) as list_unsorted,
            patch.object(datamodel, "frames_of_product", wraps=originals["frames_of_product"]) as frames_of_product,
            patch.object(datamodel, "frames_for_feature", wraps=originals["frames_for_feature"]) as frames_for_feature,
            perf.trace("status-data-benchmark", enabled=True, emit=False) as report,
        ):
            for _ in range(5):
                scope = getattr(datamodel, "render_snapshot", nullcontext)()
                with scope:
                    started = time.perf_counter()
                    current = _status_payload(
                        camera, config, datamodel, labels, versions
                    )
                    timings.append((time.perf_counter() - started) * 1000)
                    if payload is not None and current != payload:
                        raise RuntimeError("Status payload changed between repetitions")
                    payload = current

        print(json.dumps({
            "fixture": {"frames": 500, "rois": 15, "products": 4, "repeats": 5, "storage": "TemporaryDirectory"},
            "elapsed": {
                "median_ms": round(statistics.median(timings), 3),
                "min_ms": round(min(timings), 3),
                "max_ms": round(max(timings), 3),
            },
            "calls_total": {
                "load_rois": load_rois.call_count,
                "list_unsorted": list_unsorted.call_count,
                "frames_of_product": frames_of_product.call_count,
                "frames_for_feature": frames_for_feature.call_count,
            },
            "database_connections_total": report.counters.get("db.connections", 0),
            "physical_reads_total": {
                "roi_files": report.counters.get("roi.file_reads", 0),
                "unsorted_directory_scans": report.counters.get("filesystem.unsorted_scans", 0),
                "product_membership_builds": report.counters.get("product.membership_builds", 0),
            },
            "snapshot": {
                "hits": report.counters.get("render_snapshot.hits", 0),
                "misses": report.counters.get("render_snapshot.misses", 0),
            },
        }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
