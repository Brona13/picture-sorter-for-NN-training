from __future__ import annotations

import datamodel
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames


class StatusApiTests(ApiTestCase):
    def test_unknown_camera(self) -> None:
        self.assertEqual(self.client.get("/api/cameras/nope/status").status_code, 404)

    def test_camera_without_rois(self) -> None:
        write_frames("camA", 3)
        body = self.client.get("/api/cameras/camA/status").json()
        self.assertEqual(body["frame_count"], 3)
        self.assertEqual(body["feature_count"], 0)
        self.assertEqual(body["features"], [])
        self.assertEqual(body["products"], [])

    def test_counts_labels_goldens_and_versions(self) -> None:
        frames = write_frames("camA", 4)
        datamodel.save_rois("camA", [ROI(name="seal", x=0, y=0, w=0.5, h=0.5)])
        labels.set_label("camA", "seal", frames[0], "OK")
        labels.set_label("camA", "seal", frames[1], "NG")
        labels.mark_golden("camA", "seal", frames[0], "OK")

        body = self.client.get("/api/cameras/camA/status").json()
        self.assertEqual(body["feature_count"], 1)
        row = body["features"][0]
        self.assertEqual(row["feature"], "seal")
        self.assertEqual(row["role"], "quality")
        self.assertEqual(row["labeled"], {"OK": 1, "NG": 1})
        self.assertEqual(row["goldens"], {"OK": 1, "NG": 0})
        self.assertEqual(row["unlabeled"], 2)
        self.assertEqual(row["total"], 4)
        self.assertEqual(row["version_count"], 0)
        self.assertIsNone(row["active_version"])

    def test_products_and_scope_fields(self) -> None:
        write_frames("camA", 2)
        datamodel.save_rois(
            "camA",
            [
                ROI(name="prod", x=0, y=0, w=0.5, h=0.5, role="classify", classes=["P1", "P2"]),
                ROI(name="shared", x=0.5, y=0.5, w=0.4, h=0.4, products=["P1"]),
            ],
        )
        body = self.client.get("/api/cameras/camA/status").json()
        self.assertEqual(body["products"], ["P1", "P2"])
        by_name = {f["feature"]: f for f in body["features"]}
        self.assertEqual(by_name["prod"]["role"], "classify")
        self.assertEqual(by_name["prod"]["classes"], ["P1", "P2"])
        self.assertEqual(by_name["shared"]["shared_products"], ["P1"])


class DeviceApiTests(ApiTestCase):
    def test_device_endpoint_reports_kind_label_and_name(self) -> None:
        body = self.client.get("/api/device").json()
        self.assertIn(body["kind"], {"amd", "nvidia", "cpu"})
        for key in ("label", "name", "api", "hint"):
            self.assertIn(key, body)
