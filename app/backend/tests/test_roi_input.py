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
        plain = engine.crop_for_frame(CAM, "seal", datamodel.unsorted_dir(CAM) / self.name)
        self.feed()
        cut = engine.crop_for_frame(CAM, "seal", datamodel.unsorted_dir(CAM) / self.name)
        self.assertEqual(cut.shape, plain.shape)  # same place
        self.assertLess(cut.astype(float).std(), plain.astype(float).std())  # blurred noise

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

    def test_a_cropping_box_is_refused_and_cannot_become_one(self) -> None:
        self.steps([{"id": "s1", "op": "crop", "rect": [0.1, 0.1, 0.5, 0.5]}])
        self.feed(status=422)
        self.steps([self.BLUR])
        self.feed()
        self.steps([{"op": "crop", "rect": [0.1, 0.1, 0.5, 0.5]}], status=422)  # seal reads this box
        self.client.delete(f"{self.roi}/seal/input")
        self.steps([{"op": "crop", "rect": [0.1, 0.1, 0.5, 0.5]}])  # free again

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

    def test_remove_input_and_roi_delete(self) -> None:
        self.feed()
        self.assertEqual(self.client.delete(f"{self.roi}/seal/input").status_code, 200)
        self.assertIsNone(roi_input.get_input(CAM, "seal"))
        self.feed("edge")
        self.client.delete(f"{self.roi}/edge")
        self.assertIsNone(roi_input.get_input(CAM, "edge"))
