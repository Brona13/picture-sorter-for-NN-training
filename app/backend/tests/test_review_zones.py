"""The review zone of a detector target (v1.169.0): saved per target slot on the detector box, shown on its position map,
never part of the run signature. The detector of ``test_flow_count`` (one picture, target "hole")."""
from __future__ import annotations

import tests.test_flow_count as count


class ReviewZoneTests(count.CountTests):
    def zone(self, raw: dict):
        return self.client.put(f"{self.base}/nodes/{self.det}", json={"review_zone": raw})

    def detail(self) -> dict:
        return self.client.get(f"{self.base}/nodes/{self.det}").json()

    def test_a_zone_is_saved_per_slot_and_changed_field_by_field(self) -> None:
        self.assertEqual(self.detail()["review_zones"], {})
        self.assertEqual(self.zone({"slot": "hole", "zone": {"center": [60.0, 70.0], "radius": 8.0}}).status_code, 200)
        z = self.detail()["review_zones"]["hole"]
        self.assertEqual((z["shape"], z["center"], z["radius"]), ("circle", [60.0, 70.0], 8.0))
        self.zone({"slot": "hole", "zone": {"shape": "rect", "half": [5.0, 3.0]}})
        z = self.detail()["review_zones"]["hole"]
        self.assertEqual((z["shape"], z["center"], z["half"]), ("rect", [60.0, 70.0], [5.0, 3.0]))
        self.zone({"slot": "hole", "zone": None})
        self.assertEqual(self.detail()["review_zones"], {})

    def test_changing_the_zone_never_makes_the_run_stale(self) -> None:
        self.run_detector()
        self.assertEqual(self.detail()["status"], "fresh")
        self.zone({"slot": "hole", "zone": {"center": [60.0, 70.0], "radius": 8.0}})
        self.assertEqual(self.detail()["status"], "fresh")

    def test_a_zone_names_a_slot_the_detector_has(self) -> None:
        self.assertEqual(self.zone({"slot": "nope", "zone": {"center": [1.0, 1.0]}}).status_code, 422)
        self.assertEqual(self.zone({"zone": {"center": [1.0, 1.0]}}).status_code, 422)
        self.assertEqual(self.zone({"slot": "hole", "zone": {"radius": -1}}).status_code, 422)

    def test_numbered_slots_have_their_own_zones_and_a_gone_slot_is_left_out(self) -> None:
        self.set_count(2)
        self.zone({"slot": "hole 2", "zone": {"center": [210.0, 80.0]}})
        self.assertEqual(list(self.detail()["review_zones"]), ["hole 2"])
        self.set_count(1)
        self.assertEqual(self.detail()["review_zones"], {})


for _name in [n for n in dir(count.CountTests) if n.startswith("test_")]:
    setattr(ReviewZoneTests, _name, None)
