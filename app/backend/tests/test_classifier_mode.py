"""One Classifier, two modes (v1.99.0): Feature (OK / NG) or Product (its classes are product names), chosen in the panel."""
from __future__ import annotations

import datamodel
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camM"


class ClassifierModeTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 4)
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 1, 1)])
        labels.set_label(CAM, "seal", self.frames[0], "OK")
        self.base = f"/api/cameras/{CAM}"

    def put(self, feature: str, mode: str, names: list[str] | None = None):
        return self.client.put(f"{self.base}/rois/{feature}/mode", json={"mode": mode, "product_names": names or []})

    def test_a_feature_becomes_the_product_classifier_and_its_labels_are_cleared(self) -> None:
        r = self.put("seal", "product", ["A", "B"])
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["cleared"], 1)
        roi = datamodel.get_roi(CAM, "seal")
        self.assertEqual((roi.role, roi.classes), ("classify", ["A", "B"]))
        self.assertEqual(labels.current_labels(CAM, "seal"), {})
        self.assertEqual(datamodel.products(CAM), ["A", "B"])

    def test_a_camera_has_one_product_classifier_and_needs_two_names(self) -> None:
        self.assertEqual(self.put("seal", "product", ["A"]).status_code, 422)
        self.assertEqual(self.put("seal", "product", ["A", "A"]).status_code, 422)
        self.assertEqual(self.put("seal", "product", ["A", "B"]).status_code, 200)
        datamodel.save_rois(CAM, datamodel.load_rois(CAM) + [ROI("edge", 0, 0, 1, 1)])
        self.assertEqual(self.put("edge", "product", ["C", "D"]).status_code, 422)

    def test_back_to_feature_is_refused_while_another_classifier_depends_on_the_products(self) -> None:
        self.put("seal", "product", ["A", "B"])
        datamodel.save_rois(CAM, datamodel.load_rois(CAM) + [ROI("edge", 0, 0, 1, 1, products=["A"])])
        r = self.put("seal", "feature")
        self.assertEqual(r.status_code, 422)
        self.assertIn("edge", r.json()["detail"])

    def test_back_to_feature_gives_ok_ng(self) -> None:
        self.put("seal", "product", ["A", "B"])
        self.assertEqual(self.put("seal", "feature").status_code, 200)
        self.assertEqual(datamodel.classes_for(CAM, "seal"), ["OK", "NG"])
        self.assertEqual(self.put("seal", "feature").status_code, 422)  # already one
