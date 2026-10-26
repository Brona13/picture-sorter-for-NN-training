"""A detector target that looks for several similar elements in one picture (``count``): boxes go by ``name 1`` ... left to right."""
from __future__ import annotations

import cv2
import numpy as np

import datamodel
import flow
import ingest
from tests.api_helpers import ApiTestCase, wait_for_job

CAM = "camCount"


def picture_with_two_copies() -> tuple[np.ndarray, list[int]]:
    rng = np.random.default_rng(7)
    background = cv2.GaussianBlur(rng.integers(0, 255, (160, 280, 3), dtype=np.uint8), (0, 0), 2)
    patch = cv2.GaussianBlur(rng.integers(0, 255, (40, 40, 3), dtype=np.uint8), (0, 0), 1.5)
    patch = cv2.normalize(patch, None, 0, 255, cv2.NORM_MINMAX)
    picture = background.copy()
    picture[60:100, 190:230] = patch  # the right copy is drawn first: the left one must still be number 1
    picture[50:90, 40:80] = patch
    return picture, [40, 50, 40, 40]


class CountTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        datamodel.ensure_camera_dirs(CAM)
        self.picture, self.box = picture_with_two_copies()
        cv2.imwrite(str(datamodel.unsorted_dir(CAM) / "two.png"), self.picture)
        ingest.rebuild_index(CAM)
        self.base = f"/api/cameras/{CAM}/flow"
        self.det = self.client.post(f"{self.base}/nodes", json={"kind": "detector"}).json()["id"]
        self.client.post(f"{self.base}/edges", json={"source": "ingest", "target": self.det})
        self.client.post(f"{self.base}/nodes/{self.det}/targets", json={"name": "hole"})
        self.client.post(f"{self.base}/nodes/{self.det}/examples", json={"target": "hole", "frame": "two.png", "box": self.box})
        self.client.put(f"{self.base}/nodes/{self.det}", json={"rotate": False})

    def run_detector(self) -> dict:
        job = self.client.post(f"{self.base}/run").json()
        self.assertEqual(wait_for_job(self.client, job["id"])["status"], "done")
        return self.client.get(f"{self.base}/nodes/{self.det}/boxes").json()["boxes"]["two.png"]

    def set_count(self, n: int):
        return self.client.put(f"{self.base}/nodes/{self.det}/targets/hole/count", json={"count": n})

    def test_one_element_is_the_default_and_keeps_the_plain_name(self) -> None:
        boxes = self.run_detector()
        self.assertEqual(list(boxes), ["hole"])

    def test_two_elements_are_found_and_numbered_left_to_right(self) -> None:
        self.assertEqual(self.set_count(2).status_code, 200)
        detail = self.client.get(f"{self.base}/nodes/{self.det}").json()
        self.assertEqual(detail["targets"][0]["slots"], ["hole 1", "hole 2"])
        boxes = self.run_detector()
        self.assertEqual(sorted(boxes), ["hole 1", "hole 2"])
        self.assertLess(abs(boxes["hole 1"]["x"] - 60), 3)
        self.assertLess(abs(boxes["hole 2"]["x"] - 210), 3)
        self.assertLess(boxes["hole 1"]["x"], boxes["hole 2"]["x"])
        summary = self.client.get(f"{self.base}/nodes/{self.det}").json()["summary"]
        self.assertEqual(summary["found"], {"hole 1": 1, "hole 2": 1})

    def test_changing_how_many_makes_the_detector_stale(self) -> None:
        self.run_detector()
        self.assertEqual(self.client.get(f"{self.base}/nodes/{self.det}").json()["status"], "fresh")
        self.set_count(2)
        self.assertEqual(self.client.get(f"{self.base}/nodes/{self.det}").json()["status"], "stale")

    def test_lines_use_the_numbered_names_and_block_a_change_of_the_count(self) -> None:
        self.set_count(2)
        calc = self.client.post(f"{self.base}/nodes", json={"kind": "calc"}).json()["id"]
        self.assertEqual(self.client.post(f"{self.base}/edges", json={"source": self.det, "target": calc, "point": "hole"}).status_code, 422)
        self.assertEqual(self.client.post(f"{self.base}/edges", json={"source": self.det, "target": calc, "point": "hole 1"}).status_code, 201)
        self.assertEqual(self.client.post(f"{self.base}/edges", json={"source": self.det, "target": calc, "point": "hole 2"}).status_code, 201)
        detail = self.client.get(f"{self.base}/nodes/{calc}").json()
        self.assertEqual(detail["points"], ["hole 1", "hole 2"])
        refused = self.set_count(1)
        self.assertEqual(refused.status_code, 422)
        self.assertIn(calc, refused.text)

    def test_the_count_must_be_a_small_whole_number(self) -> None:
        self.assertEqual(self.set_count(0).status_code, 422)
        self.assertEqual(self.set_count(flow.MAX_COUNT + 1).status_code, 422)

    def test_placing_by_the_plain_name_takes_the_first_free_number(self) -> None:
        self.set_count(2)
        first = self.client.put(f"{self.base}/nodes/{self.det}/box", json={"frame": "two.png", "target": "hole", "x": 30, "y": 20}).json()
        second = self.client.put(f"{self.base}/nodes/{self.det}/box", json={"frame": "two.png", "target": "hole", "x": 200, "y": 20}).json()
        boxes = self.client.get(f"{self.base}/nodes/{self.det}/boxes").json()["boxes"]["two.png"]
        self.assertEqual((boxes["hole 1"]["x"], boxes["hole 2"]["x"]), (30, 200))
        self.assertEqual((first["x"], second["x"]), (30, 200))

    def test_a_box_placed_by_hand_on_one_slot_keeps_its_place(self) -> None:
        self.set_count(2)
        placed = self.client.put(f"{self.base}/nodes/{self.det}/box", json={"frame": "two.png", "target": "hole 2", "x": 100, "y": 20})
        self.assertEqual(placed.status_code, 200, placed.text)
        boxes = self.run_detector()
        self.assertEqual(boxes["hole 2"]["source"], "human")
        self.assertEqual(boxes["hole 2"]["x"], 100)
        self.assertIn("hole 1", boxes)


class CountClassifierTests(CountTests):
    """A Classifier anchored on a target with several elements works on one sample per found box (``two.png#1``)."""

    test_one_element_is_the_default_and_keeps_the_plain_name = None  # inherited tests of the single-element setup
    test_changing_how_many_makes_the_detector_stale = None
    test_two_elements_are_found_and_numbered_left_to_right = None
    test_lines_use_the_numbered_names_and_block_a_change_of_the_count = None
    test_the_count_must_be_a_small_whole_number = None
    test_placing_by_the_plain_name_takes_the_first_free_number = None
    test_a_box_placed_by_hand_on_one_slot_keeps_its_place = None

    def setUp(self) -> None:
        super().setUp()
        self.set_count(2)
        self.run_detector()
        self.client.put(f"/api/cameras/{CAM}/rois", json={"name": "pair", "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2})

    def anchor(self, target: str, mode: str = "box", **more):
        return self.client.put(f"/api/cameras/{CAM}/rois/pair/anchor", json={"detector": self.det, "target": target, "mode": mode, **more})

    def test_each_found_box_is_its_own_picture_of_the_classifier(self) -> None:
        self.assertEqual(self.anchor("hole", margin=0.0).status_code, 200)
        self.assertEqual(datamodel.frames_for_feature(CAM, "pair"), ["two.png#1", "two.png#2"])
        # the whole picture is not a picture of this Classifier, and other features still see the files
        self.assertEqual(datamodel.frames_for_feature(CAM, "whole-frame"), ["two.png"])

    def test_the_cutout_and_the_thumbnail_of_a_sample_are_that_box_alone(self) -> None:
        import engine

        self.anchor("hole", margin=0.0)
        left = engine.crop_for_frame(CAM, "pair", datamodel.unsorted_dir(CAM) / "two.png", "two.png#1")
        right = engine.crop_for_frame(CAM, "pair", datamodel.unsorted_dir(CAM) / "two.png", "two.png#2")
        self.assertAlmostEqual(left.shape[1], 40, delta=4)
        self.assertAlmostEqual(right.shape[1], 40, delta=4)
        thumbs = [self.client.get(f"/api/cameras/{CAM}/frames/{f}/thumb", params={"feature": "pair"}) for f in ("two.png%231", "two.png%232")]
        self.assertEqual([t.status_code for t in thumbs], [200, 200])
        cut = self.client.get(f"/api/cameras/{CAM}/frames/two.png%232/cutout", params={"feature": "pair"})
        self.assertEqual(cut.status_code, 200)
        self.assertEqual(self.client.get(f"/api/cameras/{CAM}/frames/two.png%232/image").status_code, 200)

    def test_the_viewer_gets_the_rectangle_of_that_box(self) -> None:
        self.anchor("hole", margin=0.0)
        one = self.client.get(f"/api/cameras/{CAM}/rois/pair/rect", params={"frame": "two.png#1"}).json()
        two = self.client.get(f"/api/cameras/{CAM}/rois/pair/rect", params={"frame": "two.png#2"}).json()
        self.assertTrue(one["anchored"])
        self.assertLess(one["rect"]["x"], two["rect"]["x"])
        self.assertAlmostEqual(one["rect"]["w"] * 280, 40, delta=4)

    def test_every_sample_has_its_own_label(self) -> None:
        import labels

        self.anchor("hole", margin=0.0)
        labels.set_label(CAM, "pair", "two.png#1", "OK")
        labels.set_label(CAM, "pair", "two.png#2", "NG")
        self.assertEqual(labels.current_labels(CAM, "pair"), {"two.png#1": "OK", "two.png#2": "NG"})
        hashes = labels.hash_map(CAM)
        self.assertEqual(hashes["two.png#2"], hashes["two.png"] + "#2")

    def test_one_numbered_box_is_only_that_sample(self) -> None:
        self.assertEqual(self.anchor("hole 2", margin=0.0).status_code, 200)
        self.assertEqual(datamodel.frames_for_feature(CAM, "pair"), ["two.png"])

    def test_a_rectangle_of_your_own_needs_one_numbered_box(self) -> None:
        refused = self.anchor("hole", mode="rect", frame="two.png")
        self.assertEqual(refused.status_code, 422)
        self.assertIn("several boxes", refused.text)

    def test_the_count_cannot_change_while_a_classifier_is_anchored_on_the_target(self) -> None:
        self.anchor("hole", margin=0.0)
        refused = self.set_count(1)
        self.assertEqual(refused.status_code, 422)
        self.assertIn("pair", refused.text)

    def test_a_missing_box_is_a_missing_sample(self) -> None:
        import flow
        import labels

        self.anchor("hole", margin=0.0)
        stored = flow.load_stored(CAM, self.det)
        key = labels.hash_map(CAM)["two.png"]
        stored["frames"][key].pop("hole 2")
        flow._store(CAM, self.det, stored["sig"], stored["frames"])
        self.assertEqual(datamodel.frames_for_feature(CAM, "pair"), ["two.png#1"])

    def test_the_classifier_vectors_are_made_from_each_box_alone(self) -> None:
        import classify
        import db
        import engine
        import labels

        self.anchor("hole", margin=0.0)
        con = db.connect()
        try:
            roi = engine.resolve_roi(CAM, "pair")
            vectors = classify.fetch_vectors(con, CAM, "pair", classify._roi_cache_key(roi, CAM, "pair", con), roi, ["two.png#1", "two.png#2"],
                                             labels.hash_map(CAM), [], include_classical=True)
        finally:
            con.close()
        self.assertEqual(sorted(vectors), ["two.png#1", "two.png#2"])

    def test_the_chain_draws_an_arrow_from_each_numbered_dot_to_the_classifier(self) -> None:
        self.anchor("hole", margin=0.0)
        chain = self.client.get(f"/api/cameras/{CAM}/chain").json()
        handles = sorted(e["source_handle"] for e in chain["edges"] if e["target"] == "roi:pair")
        self.assertEqual(handles, ["t:hole 1", "t:hole 2"])
        det = next(n for n in chain["nodes"] if n["id"] == self.det)
        self.assertEqual(det["flow"]["groups"], ["hole"])
