"""A ROI that reads a Picture edits box (filters only). Temp roots only."""
from __future__ import annotations

import cv2
import numpy as np

import classify
import datamodel
import engine
import ingest
import roi_input
from roi import ROI
from tests.api_helpers import ApiTestCase

CAM = "camR"


class RoiInputTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        datamodel.ensure_camera_dirs(CAM)
        rng = np.random.default_rng(3)
        self.name = "p_0.png"
        cv2.imwrite(str(datamodel.unsorted_dir(CAM) / self.name), rng.integers(0, 256, (80, 120, 3), dtype=np.uint8))
        ingest.rebuild_index(CAM)
        datamodel.save_rois(CAM, [ROI("seal", 0.0, 0.0, 0.5, 0.5), ROI("edge", 0.5, 0.5, 0.5, 0.5)])
        self.flow = f"/api/cameras/{CAM}/flow"
        self.roi = f"/api/cameras/{CAM}/rois"
        self.box = self.client.post(f"{self.flow}/nodes", json={"kind": "crop"}).json()["id"]

    def steps(self, steps, status=200):
        r = self.client.put(f"{self.flow}/nodes/{self.box}", json={"steps": steps})
        self.assertEqual(r.status_code, status, r.text)

    def feed(self, feature="seal", status=200):
        r = self.client.put(f"{self.roi}/{feature}/input", json={"box": self.box})
        self.assertEqual(r.status_code, status, r.text)
        return r

    BLUR = {"op": "filter", "name": "gaussian", "params": {"sigma": 3.0}}

    def test_crop_sees_filtered_pixels(self) -> None:
        self.steps([self.BLUR])
        whole = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.name))
        self.feed()
        cut = engine.crop_for_frame(CAM, "seal", datamodel.unsorted_dir(CAM) / self.name)
        self.assertEqual(cut.shape, whole.shape)  # the whole edited picture (the ROI starts as 0, 0, 1, 1)
        self.assertLess(cut.astype(float).std(), whole.astype(float).std())  # blurred noise

    def test_cache_key_follows_the_box_filters(self) -> None:
        self.steps([self.BLUR])
        roi = engine.resolve_roi(CAM, "seal")
        before = classify._roi_cache_key(roi, CAM, "seal")
        self.feed()
        fed = classify._roi_cache_key(roi, CAM, "seal")
        self.steps([{**self.BLUR, "params": {"sigma": 4.0}}])
        changed = classify._roi_cache_key(roi, CAM, "seal")
        self.assertEqual(len({before, fed, changed}), 3)

    def test_thumbnail_uses_the_filtered_picture(self) -> None:
        self.steps([self.BLUR])
        url = f"/api/cameras/{CAM}/frames/{self.name}/thumb"
        plain = self.client.get(url, params={"feature": "seal"}).content
        self.feed()
        fed = self.client.get(url, params={"feature": "seal"}).content
        self.assertNotEqual(plain, fed)

    def test_a_cropping_box_cuts_the_roi_from_the_edited_picture(self) -> None:
        self.steps([{"op": "crop", "rect": [0.25, 0.25, 0.5, 0.5]}, self.BLUR])
        self.feed()
        roi = engine.resolve_roi(CAM, "seal")
        self.assertEqual((roi.x, roi.y, roi.w, roi.h), (0.0, 0.0, 1.0, 1.0))  # starts as the whole edited picture
        cut = engine.crop_for_frame(CAM, "seal", datamodel.unsorted_dir(CAM) / self.name)
        self.assertEqual(cut.shape[:2], (40, 60))  # half of 80 x 120

    def test_a_following_crop_gives_no_picture_where_the_detector_found_nothing(self) -> None:
        import flow  # noqa: PLC0415
        import labels  # noqa: PLC0415

        cv2.imwrite(str(datamodel.unsorted_dir(CAM) / "p_1.png"), np.zeros((80, 120, 3), np.uint8))
        ingest.rebuild_index(CAM)
        det = self.client.post(f"{self.flow}/nodes", json={"kind": "detector"}).json()["id"]
        self.client.post(f"{self.flow}/nodes/{det}/targets", json={"name": "A"})
        key = labels.hash_map(CAM)[self.name]
        flow._store(CAM, det, flow.signature(flow.load_graph(CAM), det), {key: {"A": {"x": 60.0, "y": 40.0}}})
        self.assertEqual(self.client.post(f"{self.flow}/edges", json={"source": det, "target": self.box, "point": "A"}).status_code, 201)
        r = self.client.put(f"{self.flow}/nodes/{self.box}", json={"follow": {"frame": self.name, "rect": [30, 20, 60, 40]}})
        self.assertEqual(r.status_code, 200, r.text)
        self.steps([self.client.get(f"{self.flow}/nodes/{self.box}").json()["steps"][0], self.BLUR])
        self.feed()
        cut = engine.crop_for_frame(CAM, "seal", datamodel.unsorted_dir(CAM) / self.name)
        self.assertEqual(cut.shape[:2], (40, 60))
        with self.assertRaises(FileNotFoundError):
            engine.crop_for_frame(CAM, "seal", datamodel.unsorted_dir(CAM) / "p_1.png")
        thumb = f"/api/cameras/{CAM}/frames/p_1.png/thumb"
        self.assertEqual(self.client.get(thumb, params={"feature": "seal"}).status_code, 404)
        self.assertEqual(self.client.get(f"/api/cameras/{CAM}/frames/{self.name}/thumb", params={"feature": "seal"}).status_code, 200)

    def test_anchored_roi_cannot_read_a_box_and_back(self) -> None:
        det = self.client.post(f"{self.flow}/nodes", json={"kind": "detector"}).json()["id"]
        self.client.post(f"{self.flow}/nodes/{det}/targets", json={"name": "t"})
        r = self.client.put(f"{self.roi}/seal/anchor", json={"detector": det, "target": "t", "mode": "box"})
        self.assertEqual(r.status_code, 200, r.text)
        self.feed(status=422)
        self.client.delete(f"{self.roi}/seal/anchor")
        self.feed()
        again = self.client.put(f"{self.roi}/seal/anchor", json={"detector": det, "target": "t", "mode": "box"})
        self.assertEqual(again.status_code, 422)

    def test_chain_shows_the_arrow_and_deleting_the_box_frees_the_roi(self) -> None:
        self.feed()
        chain = self.client.get(f"/api/cameras/{CAM}/chain").json()
        self.assertIn(f"{self.box}->roi:seal", [e["id"] for e in chain["edges"]])
        self.assertNotIn("ingest->roi:seal", [e["id"] for e in chain["edges"]])
        self.assertEqual(self.client.delete(f"{self.flow}/nodes/{self.box}").status_code, 200)
        self.assertIsNone(roi_input.get_input(CAM, "seal"))
        edges = self.client.get(f"/api/cameras/{CAM}/chain").json()["edges"]
        self.assertTrue(any(e["target"] == "roi:seal" for e in edges))  # back on Ingest

    def test_product_classifier_reads_a_box_and_keeps_its_input_when_the_mode_changes(self) -> None:
        self.feed()
        r = self.client.put(f"{self.roi}/seal/mode", json={"mode": "product", "product_names": ["A", "B"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(roi_input.get_input(CAM, "seal"), {"box": self.box})
        edges = [e["id"] for e in self.client.get(f"/api/cameras/{CAM}/chain").json()["edges"]]
        self.assertIn(f"{self.box}->roi:seal", edges)
        self.assertNotIn("ingest->roi:seal", edges)
        self.feed("seal")  # and a line can be drawn onto the Product Classifier directly

    def test_product_classifier_keeps_its_detector_anchor_when_the_mode_changes(self) -> None:
        det = self.client.post(f"{self.flow}/nodes", json={"kind": "detector"}).json()["id"]
        self.client.post(f"{self.flow}/nodes/{det}/targets", json={"name": "t"})
        self.assertEqual(self.client.put(f"{self.roi}/seal/anchor", json={"detector": det, "target": "t", "mode": "box"}).status_code, 200)
        self.assertEqual(self.client.put(f"{self.roi}/seal/mode", json={"mode": "product", "product_names": ["A", "B"]}).status_code, 200)
        edges = [e["id"] for e in self.client.get(f"/api/cameras/{CAM}/chain").json()["edges"]]
        self.assertIn(f"{det}->roi:seal", edges)

    def test_remove_input_and_roi_delete(self) -> None:
        self.feed()
        self.assertEqual(self.client.delete(f"{self.roi}/seal/input").status_code, 200)
        self.assertIsNone(roi_input.get_input(CAM, "seal"))
        self.feed("edge")
        self.client.delete(f"{self.roi}/edge")
        self.assertIsNone(roi_input.get_input(CAM, "edge"))
