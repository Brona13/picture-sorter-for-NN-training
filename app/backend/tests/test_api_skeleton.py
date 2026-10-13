from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from fastapi.testclient import TestClient

import config
import datamodel
import db
from api.main import create_app
from roi import ROI


class ApiSkeletonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="picture-sorter-api-test-")
        root = Path(self.tmp.name)
        self._old = (config.CAMERAS_ROOT, config.DATA_DIR)
        config.CAMERAS_ROOT = root / "cameras"
        config.DATA_DIR = root / "data"
        datamodel.ensure_camera_dirs("camA")
        datamodel.ensure_camera_dirs("camB")
        datamodel.save_rois(
            "camA",
            [
                ROI(name="prod", x=0, y=0, w=0.5, h=0.5, role="classify", classes=["P1", "P2"]),
                ROI(name="seal", x=0.5, y=0.5, w=0.4, h=0.4),
            ],
        )
        self.client = TestClient(create_app())

    def tearDown(self) -> None:
        config.CAMERAS_ROOT, config.DATA_DIR = self._old
        self.tmp.cleanup()

    def test_health(self) -> None:
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"status": "ok"})

    def test_cameras(self) -> None:
        self.assertEqual(self.client.get("/api/cameras").json(), ["camA", "camB"])

    def test_products_and_features(self) -> None:
        self.assertEqual(self.client.get("/api/cameras/camA/products").json(), ["P1", "P2"])
        self.assertEqual(self.client.get("/api/cameras/camB/products").json(), [])
        feats = self.client.get("/api/cameras/camA/features").json()
        self.assertIn("seal", feats)

    def test_unknown_camera_and_traversal(self) -> None:
        self.assertEqual(self.client.get("/api/cameras/nope/products").status_code, 404)
        self.assertEqual(self.client.get("/api/cameras/..%2F..%2Fetc/features").status_code, 404)

    def test_unknown_product(self) -> None:
        r = self.client.get("/api/cameras/camA/features", params={"product": "X"})
        self.assertEqual(r.status_code, 404)

    def test_database_reset_maps_to_409(self) -> None:
        # No built frontend: its catch-all would shadow routes added after create_app().
        with mock.patch.dict(os.environ, {"CURATION_FRONTEND_DIST": str(Path(self.tmp.name) / "none")}):
            app = create_app()

        @app.get("/api/_boom")
        def boom() -> None:
            raise db.DatabaseResetRequired("old schema")

        r = TestClient(app).get("/api/_boom")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["error"], "database_reset_required")


if __name__ == "__main__":
    unittest.main()
