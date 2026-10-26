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
