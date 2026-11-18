"""The pair map of a detector (v1.170.0): two targets measured like Calculate and judged like Evaluation, saved on the
detector box, review only. The detector of ``test_flow_count`` set to find two holes: "hole 1" near (60, 70) and
"hole 2" near (210, 80) on the one picture ``two.png``."""
from __future__ import annotations

import flow
import tests.test_flow_count as count


class ReviewPairTests(count.CountTests):
    def setUp(self) -> None:
        super().setUp()
        self.set_count(2)
        self.run_detector()

    def pair(self, raw):
        return self.client.put(f"{self.base}/nodes/{self.det}", json={"review_pair": raw})

    def state(self) -> dict:
        r = self.client.get(f"{self.base}/nodes/{self.det}/pair")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_no_pair_measures_nothing(self) -> None:
        s = self.state()
        self.assertIsNone(s["pair"])
        self.assertEqual((s["values"], s["counts"]["fail"]), ({}, 0))
        self.assertIn("distance", s["operations"])

    def test_the_value_is_the_one_calculate_gives_and_the_band_judges_it(self) -> None:
        self.assertEqual(self.pair({"a": "hole 1", "b": "hole 2", "op": "distance"}).status_code, 200)
        s = self.state()
        boxes = self.client.get(f"{self.base}/nodes/{self.det}/boxes").json()["boxes"]["two.png"]
        a, b = boxes["hole 1"], boxes["hole 2"]
        self.assertAlmostEqual(s["values"]["two.png"], flow.compute("distance", (a["x"], a["y"]), (b["x"], b["y"])), places=6)
        self.assertEqual(s["verdicts"]["two.png"], "undetermined")  # no nominal yet
        self.assertIsNotNone(s["histogram"])
        self.pair({"nominal": round(s["values"]["two.png"]), "tolerance": 3})
        self.assertEqual(self.state()["verdicts"]["two.png"], "pass")
        self.pair({"nominal": 100, "tolerance": 3})
        self.assertEqual(self.state()["counts"], {"pass": 0, "fail": 1, "undetermined": 0})

    def test_an_offset_is_judged_by_a_zone_and_a_new_operation_starts_over(self) -> None:
        self.pair({"a": "hole 1", "b": "hole 2", "op": "offset", "zone": {"center": [150.0, 10.0], "radius": 5.0}})
        s = self.state()
        self.assertEqual(s["mode"], "zone")
        dx, dy = s["points"]["two.png"]
        self.assertLess(abs(dx - 150), 3)
        self.assertLess(abs(dy - 10), 3)
        self.assertEqual(s["verdicts"]["two.png"], "pass")
        self.pair({"op": "angle"})
        pair = self.state()["pair"]
        self.assertEqual((pair["op"], pair["nominal"], pair["zone"]["center"]), ("angle", None, None))
        self.assertTrue(self.state()["wrap"])

    def test_the_pair_never_makes_the_run_stale_and_can_be_removed(self) -> None:
        self.pair({"a": "hole 1", "b": "hole 2"})
        detail = self.client.get(f"{self.base}/nodes/{self.det}").json()
        self.assertEqual((detail["status"], detail["review_pair"]["op"]), ("fresh", "distance"))
        self.pair(None)
        self.assertIsNone(self.client.get(f"{self.base}/nodes/{self.det}").json()["review_pair"])

    def test_bad_pairs_are_refused(self) -> None:
        self.assertEqual(self.pair({"a": "hole 1"}).status_code, 422)  # no B
        self.assertEqual(self.pair({"a": "hole 1", "b": "hole 1"}).status_code, 422)
        self.assertEqual(self.pair({"a": "hole 1", "b": "nope"}).status_code, 422)
        self.assertEqual(self.pair({"a": "hole 1", "b": "hole 2", "op": "area"}).status_code, 422)
        self.assertEqual(self.pair({"a": "hole 1", "b": "hole 2", "tolerance": -1}).status_code, 422)

    def test_a_gone_target_drops_the_pair(self) -> None:
        self.pair({"a": "hole 1", "b": "hole 2"})
        self.set_count(1)
        self.assertIsNone(self.state()["pair"])


for _name in [n for n in dir(count.CountTests) if n.startswith("test_")]:
    setattr(ReviewPairTests, _name, None)
