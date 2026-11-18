"""The box-value rules of a detector target (v1.172.0): a match-score threshold and an angle band, saved per target slot
on the detector box, review only (never in the run signature). The detector of ``test_flow_count``."""
from __future__ import annotations

import tests.test_flow_count as count


class ReviewValueTests(count.CountTests):
    def rule(self, raw: dict):
        return self.client.put(f"{self.base}/nodes/{self.det}", json={"review_value": raw})

    def values(self) -> dict:
        return self.client.get(f"{self.base}/nodes/{self.det}").json()["review_values"]

    def test_a_threshold_and_an_angle_band_are_saved_and_cleared_one_by_one(self) -> None:
        self.assertEqual(self.values(), {})
        self.assertEqual(self.rule({"slot": "hole", "score_min": 0.6}).status_code, 200)
        self.rule({"slot": "hole", "angle": {"nominal": 370, "tolerance": 4}})
        self.assertEqual(self.values(), {"hole": {"score_min": 0.6, "angle": {"nominal": 10.0, "tolerance": 4.0}}})  # 370 is 10
        self.rule({"slot": "hole", "score_min": None})
        self.assertEqual(self.values(), {"hole": {"angle": {"nominal": 10.0, "tolerance": 4.0}}})
        self.rule({"slot": "hole", "angle": None})
        self.assertEqual(self.values(), {})

    def test_the_rules_never_make_the_run_stale(self) -> None:
        self.run_detector()
        self.rule({"slot": "hole", "score_min": 0.6, "angle": {"nominal": 0, "tolerance": 5}})
        self.assertEqual(self.client.get(f"{self.base}/nodes/{self.det}").json()["status"], "fresh")

    def test_bad_rules_are_refused_and_a_gone_slot_is_left_out(self) -> None:
        self.assertEqual(self.rule({"slot": "nope", "score_min": 0.5}).status_code, 422)
        self.assertEqual(self.rule({"slot": "hole", "score_min": 1.5}).status_code, 422)
        self.assertEqual(self.rule({"slot": "hole", "angle": {"nominal": 0, "tolerance": 200}}).status_code, 422)
        self.assertEqual(self.rule({"slot": "hole", "angle": {"nominal": "x"}}).status_code, 422)
        self.set_count(2)
        self.rule({"slot": "hole 2", "score_min": 0.5})
        self.set_count(1)
        self.assertEqual(self.values(), {})


for _name in [n for n in dir(count.CountTests) if n.startswith("test_")]:
    setattr(ReviewValueTests, _name, None)
