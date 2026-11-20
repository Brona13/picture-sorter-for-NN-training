"""A detector target's score threshold that decides (v1.174.0): a box that scored below it counts as not found for every reader,
the stored boxes keep their scores, and the boxes behind the detector go stale when it changes. The detector of ``test_flow_count``."""
from __future__ import annotations

import flow
import labels
import tests.test_flow_count as count
from tests.test_flow_count import CAM


class DecidedThresholdTests(count.CountTests):
    def rule(self, raw: dict):
        return self.client.put(f"{self.base}/nodes/{self.det}", json={"review_value": raw})

    def weaken(self, slot: str, score: float) -> None:
        """Give the stored box of ``slot`` a low match score, as a weak hit would have."""
        key = labels.hash_map(CAM)["two.png"]
        stored = flow.load_stored(CAM, self.det, raw=True)
        stored["frames"][key][slot]["score"] = score
        flow._store(CAM, self.det, stored["sig"], stored["frames"])

    def detail(self) -> dict:
        return self.client.get(f"{self.base}/nodes/{self.det}").json()

    def test_flag_only_changes_nothing_for_the_readers(self) -> None:
        self.run_detector()
        self.weaken("hole", 0.3)
        self.rule({"slot": "hole", "score_min": 0.5})
        self.assertEqual(self.detail()["summary"]["found"], {"hole": 1})
        self.assertEqual(self.detail()["summary"]["review"], 0)

    def test_a_deciding_threshold_makes_a_weak_box_not_found(self) -> None:
        self.run_detector()
        self.weaken("hole", 0.3)
        self.rule({"slot": "hole", "score_min": 0.5, "decides": True})
        summary = self.detail()["summary"]
        self.assertEqual(summary["found"], {"hole": 0})
        self.assertEqual(summary["review"], 1)
        self.assertEqual(flow.review_frames(CAM, self.det), ["two.png"])
        key = labels.hash_map(CAM)["two.png"]
        self.assertEqual(flow.load_stored(CAM, self.det)["frames"][key], {})  # what every reader sees
        self.assertIn("hole", flow.load_stored(CAM, self.det, raw=True)["frames"][key])  # nothing was thrown away
        self.assertIn("hole", self.client.get(f"{self.base}/nodes/{self.det}/boxes").json()["boxes"]["two.png"])  # the page still sees the score
        self.rule({"slot": "hole", "score_min": 0.2, "decides": True})  # a lower threshold brings it back, no new run
        self.assertEqual(self.detail()["summary"]["found"], {"hole": 1})
        self.rule({"slot": "hole", "decides": False})
        self.assertEqual(self.detail()["summary"]["found"], {"hole": 1})

    def test_a_strong_box_stays_found(self) -> None:
        self.run_detector()
        self.rule({"slot": "hole", "score_min": 0.5, "decides": True})
        self.assertEqual(self.detail()["summary"]["found"], {"hole": 1})

    def test_the_threshold_never_makes_the_detectors_own_run_stale_but_the_boxes_behind_it(self) -> None:
        second = self.client.post(f"{self.base}/nodes", json={"kind": "detector"}).json()["id"]
        self.assertEqual(self.client.post(f"{self.base}/edges", json={"source": self.det, "target": second}).status_code, 201)
        self.client.post(f"{self.base}/nodes/{second}/targets", json={"name": "inner"})
        self.client.post(f"{self.base}/nodes/{second}/examples", json={"target": "inner", "frame": "two.png", "box": [45, 55, 20, 20]})
        self.run_detector()
        self.assertEqual(self.client.get(f"{self.base}/nodes/{second}").json()["status"], "fresh")
        self.rule({"slot": "hole", "score_min": 0.5, "decides": True})
        self.assertEqual(self.detail()["status"], "fresh")  # the stored boxes keep their scores: no new run
        self.assertEqual(self.client.get(f"{self.base}/nodes/{second}").json()["status"], "stale")  # what counted as found changed
        self.rule({"slot": "hole", "decides": False})
        self.assertEqual(self.client.get(f"{self.base}/nodes/{second}").json()["status"], "fresh")

    def test_placing_a_box_by_hand_keeps_the_boxes_a_threshold_hides(self) -> None:
        self.set_count(2)
        self.run_detector()
        self.weaken("hole 2", 0.3)
        self.rule({"slot": "hole 2", "score_min": 0.5, "decides": True})
        self.assertEqual(self.detail()["summary"]["found"], {"hole 1": 1, "hole 2": 0})
        flow.set_box(CAM, self.det, "two.png", "hole 1", 60.0, 70.0)
        raw = flow.load_stored(CAM, self.det, raw=True)["frames"][labels.hash_map(CAM)["two.png"]]
        self.assertIn("hole 2", raw)  # still stored, only hidden
        self.assertEqual(raw["hole 1"]["source"], "human")

    def test_a_human_box_counts_whatever_the_threshold(self) -> None:
        self.run_detector()
        flow.set_box(CAM, self.det, "two.png", "hole", 60.0, 70.0)
        self.rule({"slot": "hole", "score_min": 1.0, "decides": True})
        self.assertEqual(self.detail()["summary"]["found"], {"hole": 1})

    def test_removing_the_threshold_removes_the_decision(self) -> None:
        self.rule({"slot": "hole", "score_min": 0.5, "decides": True})
        self.assertEqual(self.detail()["review_values"], {"hole": {"score_min": 0.5, "decides": True}})
        self.rule({"slot": "hole", "score_min": None})
        self.assertEqual(self.detail()["review_values"], {})


for _name in [n for n in dir(count.CountTests) if n.startswith("test_")]:
    setattr(DecidedThresholdTests, _name, None)
