"""The step-1 measurements a step-2 Classifier's viewer draws (``step_two_measures``, v1.164.0). Temp roots only; the
step-2 chain (Freeze, piles, Box, Classifier "pick") is the one of ``test_box_chain``."""
from __future__ import annotations

import flow
import tests.test_box_chain as box_chain

CAM = box_chain.CAM


class StepTwoMeasuresTests(box_chain.BoxChainTests):
    """Builds on the step-2 chain of ``BoxChainTests``; its own tests are switched off below, they run in their file."""

    def evaluation(self, op: str, raw: dict) -> str:
        calc = flow.create_node(CAM, "calc")
        flow.connect(CAM, self.det, calc)
        flow.update_node(CAM, calc, {"op": op, "a": "left hole", "b": "right hole"})
        ev = flow.create_node(CAM, "evaluation")
        flow.connect(CAM, calc, ev)
        flow.update_node(CAM, ev, raw)
        return ev

    def measures(self, frame: str | None = None, feature: str = "pick") -> dict:
        r = self.client.get(f"{self.base}/rois/{feature}/measures", params={"frame": frame} if frame else {})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_every_step_one_evaluation_is_drawn_with_its_rule_boxes_and_verdict(self) -> None:
        self.assertEqual(self.measures(), {"available": False, "evaluations": 0, "changed": False})  # nothing to draw yet
        zone = self.evaluation("offset", {"zone": {"shape": "circle", "center": [40.0, 0.0], "radius": 5.0}})
        dx = self.evaluation("dx", {"nominal": 30.0, "tolerance": 2.0})  # 40 measured: fails
        summary = self.measures()
        self.assertEqual((summary["available"], summary["evaluations"]), (True, 2))
        got = self.measures(self.frames[0])
        self.assertEqual(got["frame"], self.frames[0])
        by_id = {m["evaluation"]: m for m in got["measures"]}
        self.assertEqual(set(by_id), {zone, dx})
        z = by_id[zone]
        self.assertEqual((z["mode"], z["op"], z["verdict"]), ("zone", "offset", "pass"))
        self.assertEqual((z["zone"]["shape"], z["zone"]["center"], z["zone"]["radius"]), ("circle", [40.0, 0.0], 5.0))
        self.assertEqual((z["a"]["x"], z["a"]["y"], z["b"]["x"], z["b"]["y"]), (30.0, 30.0, 70.0, 30.0))  # whole-picture positions
        d = by_id[dx]
        self.assertEqual((d["mode"], d["op"], d["nominal"], d["tolerance"], d["verdict"]), ("tolerance", "dx", 30.0, 2.0, "fail"))

    def test_only_a_step_two_classifier_gets_the_drawing(self) -> None:
        self.evaluation("offset", {"zone": {"shape": "circle", "center": [40.0, 0.0], "radius": 5.0}})
        self.assertFalse(self.measures(feature="seal")["available"])  # the step-1 Classifier
        self.assertEqual(self.measures(self.frames[0], feature="seal")["measures"], [])

    def test_a_missing_point_is_none_and_an_evaluation_in_step_two_is_not_drawn(self) -> None:
        ev = self.evaluation("offset", {"zone": {"shape": "circle", "center": [40.0, 0.0], "radius": 5.0}})
        graph = flow.load_graph(CAM)
        graph["nodes"][ev]["step"] = 2  # an Evaluation of step 2 is not a step-1 measurement
        flow.save_graph(CAM, graph)
        self.assertFalse(self.measures()["available"])
        graph["nodes"][ev].pop("step")
        flow.save_graph(CAM, graph)
        stored = flow.load_stored(CAM, self.det)["frames"]
        del stored[self.hmap[self.frames[1]]]["right hole"]
        flow._store(CAM, self.det, flow.signature(flow.load_graph(CAM), self.det), stored)
        m = self.measures(self.frames[1])["measures"][0]
        self.assertEqual(m["verdict"], "undetermined")
        self.assertIsNone(m["b"])
        self.assertEqual(m["a"]["x"], 30.0)

    def test_the_summary_says_when_step_one_changed_since_its_freeze(self) -> None:
        self.evaluation("offset", {"zone": {"shape": "circle", "center": [40.0, 0.0], "radius": 5.0}})
        self.assertFalse(self.measures()["changed"])
        import labels

        labels.set_label(CAM, "seal", self.frames[6], "OK")  # a picture the freeze did not have
        self.assertTrue(self.measures()["changed"])


for _name in [n for n in dir(box_chain.BoxChainTests) if n.startswith("test_")]:
    setattr(StepTwoMeasuresTests, _name, None)
