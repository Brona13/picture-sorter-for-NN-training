"""Measure Streamlit's backend preparation of 24/48/96-card grids safely.

This uses Streamlit AppTest and a temporary camera/database. It measures Python
rerun and delta construction time; browser layout/paint time is intentionally
outside the result and should be inspected interactively when needed.
"""

from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np
from streamlit.testing.v1 import AppTest

import config
import datamodel
import db
import labels
import ui_common
from roi import ROI


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PAGE_SIZES = (24, 48, 96)


def _create_images(root: Path, count: int) -> list[str]:
    unsorted = root / "unsorted"
    unsorted.mkdir(parents=True, exist_ok=True)
    names: list[str] = []
    for index in range(count):
        y, x = np.indices((240, 320))
        image = np.stack(
            (
                (x + index * 11) % 256,
                (y * 2 + index * 23) % 256,
                ((x + y) * 3 + index * 37) % 256,
            ),
            axis=-1,
        ).astype(np.uint8)
        name = f"frame_{index:03d}.jpg"
        cv2.imwrite(str(unsorted / name), image)
        names.append(name)
    return names


def run() -> dict[str, object]:
    old_data = config.DATA_DIR
    old_cameras = config.CAMERAS_ROOT
    old_embedding = config.EMBEDDING_ENABLED
    results: list[dict[str, object]] = []
    try:
        with tempfile.TemporaryDirectory(prefix="picture-sorter-grid-") as temp_dir:
            root = Path(temp_dir)
            config.DATA_DIR = root / "data"
            config.CAMERAS_ROOT = root / "cameras"
            config.EMBEDDING_ENABLED = False

            camera = "synthetic-camera"
            feature = "inspection"
            names = _create_images(config.CAMERAS_ROOT / camera, max(PAGE_SIZES))
            datamodel.save_rois(camera, [ROI(feature, 0.1, 0.1, 0.8, 0.8)])
            labels.set_label(camera, feature, names[0], "OK", source="benchmark")
            labels.set_label(camera, feature, names[1], "NG", source="benchmark")
            labels.mark_golden(camera, feature, names[0], "OK")
            labels.mark_golden(camera, feature, names[1], "NG")

            app = AppTest.from_file(PROJECT_ROOT / "scripts" / "app.py", default_timeout=60)
            app.run()
            app.radio[0].set_value("Classify").run()
            refresh = next(button for button in app.button if "Refresh scores" in button.label)
            refresh.click().run()
            if app.exception:
                raise RuntimeError(str(app.exception[0]))

            for page_size in PAGE_SIZES:
                ui_common.clear_thumbnail_caches()
                per_page = next(widget for widget in app.selectbox if widget.label == "Per page")
                started = time.perf_counter()
                per_page.set_value(page_size).run()
                elapsed_ms = (time.perf_counter() - started) * 1_000.0
                if app.exception:
                    raise RuntimeError(str(app.exception[0]))
                results.append(
                    {
                        "page_size": page_size,
                        "backend_render_ms": round(elapsed_ms, 3),
                        "cache": ui_common.thumbnail_cache_info()["cutout"],
                    }
                )
    finally:
        config.DATA_DIR = old_data
        config.CAMERAS_ROOT = old_cameras
        config.EMBEDDING_ENABLED = old_embedding
        ui_common.clear_thumbnail_caches()
    return {
        "scope": "Streamlit backend rerun and delta construction; excludes browser paint",
        "results": results,
    }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
