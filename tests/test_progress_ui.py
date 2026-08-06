from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from streamlit.testing.v1 import AppTest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import classify
import config
import datamodel
import db
import labels
from benchmark_performance import _create_images
from roi import ROI


class ScoringProgressUITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        self.old_embedding = config.EMBEDDING_ENABLED
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"
        config.EMBEDDING_ENABLED = False

        self.camera = "synthetic-camera"
        self.feature = "inspection"
        names = _create_images(
            config.CAMERAS_ROOT / self.camera, 8, 64, cv2, np
        )
        datamodel.save_rois(
            self.camera, [ROI(self.feature, 0.1, 0.1, 0.8, 0.8)]
        )
        for i, frame in enumerate(names):
            labels.set_label(
                self.camera,
                self.feature,
                frame,
                "OK" if i % 2 == 0 else "NG",
                source="test",
            )
        labels.mark_golden(self.camera, self.feature, names[0], "OK")
        labels.mark_golden(self.camera, self.feature, names[1], "NG")

    def tearDown(self):
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        config.EMBEDDING_ENABLED = self.old_embedding
        self.tmp.cleanup()

    def test_refresh_finishes_with_completed_status_and_cached_results(self):
        app = AppTest.from_file(PROJECT_ROOT / "scripts" / "app.py", default_timeout=30)
        app.run()
        app.radio[0].set_value("Classify").run()
        self.assertFalse(app.exception)

        refresh = next(button for button in app.button if button.label == "🔄 Refresh scores")
        refresh.click().run()

        self.assertFalse(app.exception)
        self.assertTrue(app.status)
        self.assertEqual("complete", app.status[0].state)
        self.assertEqual("Scores refreshed", app.status[0].label)

        roi_key = classify._roi_cache_key(
            ROI(self.feature, 0.1, 0.1, 0.8, 0.8)
        )
        self.assertIsNotNone(db.load_results(self.camera, self.feature, roi_key))


if __name__ == "__main__":
    unittest.main()
