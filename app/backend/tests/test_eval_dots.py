"""The pass / fail / all dots of an Evaluation box feed Dedup, Picture edits and detector boxes (temporary roots only)."""
from __future__ import annotations

from unittest import mock

import dedup_box
import flow
import lines
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camEval"


class EvaluationDotTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 6)
        self.eval = flow.create_node(CAM, "evaluation")
        self.dedup = flow.create_node(CAM, "dedup")
        self.edits = flow.create_node(CAM, "crop")
        self.det = flow.create_node(CAM, "detector")
        self.base = f"/api/cameras/{CAM}"
        verdicts = {self.frames[0]: "pass", self.frames[1]: "pass", self.frames[2]: "fail", self.frames[3]: "fail", self.frames[4]: "undetermined"}  # the last frame was not measured
        self.state = mock.patch.object(flow, "evaluation_state", return_value={"verdicts": verdicts, "unit": "px", "mode": "tolerance", "zone": None, "counts": {"pass": 2, "fail": 2, "undetermined": 1}})
        self.state.start()
        self.addCleanup(self.state.stop)

    def read(self, box: str, dot: str) -> list[str]:
        flow.update_node(CAM, box, {"source": {"box": self.eval, "dot": dot}})
        return sorted(flow.node_frames(CAM, box))

    def test_the_dots_pass_the_pictures_judged_pass_fail_or_both_but_never_an_undetermined_one(self) -> None:
        self.assertEqual(self.read(self.dedup, "pass"), sorted(self.frames[:2]))
        self.assertEqual(self.read(self.dedup, "fail"), sorted(self.frames[2:4]))
        self.assertEqual(self.read(self.dedup, lines.ALL_DOT), sorted(self.frames[:4]))
        self.assertEqual(dedup_box.frames(CAM, self.dedup), sorted(self.frames[:4]))

    def test_a_picture_edits_box_and_a_detector_read_a_dot_too(self) -> None:
        self.assertEqual(self.read(self.edits, "pass"), sorted(self.frames[:2]))
        self.assertEqual(self.read(self.det, "fail"), sorted(self.frames[2:4]))

    def test_a_bad_dot_or_box_is_refused(self) -> None:
        with self.assertRaises(flow.FlowError):
            flow.update_node(CAM, self.dedup, {"source": {"box": self.eval, "dot": "maybe"}})
        with self.assertRaises(flow.FlowError):
            flow.update_node(CAM, self.dedup, {"source": {"box": "eval:99", "dot": "pass"}})
        with self.assertRaises(flow.FlowError):
            flow.update_node(CAM, self.dedup, {"source": {"box": self.det, "dot": "pass"}})  # a detector has no such dots

    def test_a_box_cannot_read_an_evaluation_it_feeds(self) -> None:
        flow.connect(CAM, "ingest", self.det)
        flow.update_node(CAM, self.det, {"source": None})
        flow.connect(CAM, "ingest", self.det)
        calc = flow.create_node(CAM, "calc")
        flow.connect(CAM, self.det, calc)
        flow.connect(CAM, calc, self.eval)
        with self.assertRaises(flow.FlowError) as raised:
            flow.update_node(CAM, self.det, {"source": {"box": self.eval, "dot": "pass"}})
        self.assertIn("cannot read", str(raised.exception))

    def test_the_chain_draws_the_line_from_the_dot_and_a_line_from_ingest_replaces_it(self) -> None:
        flow.update_node(CAM, self.dedup, {"source": {"box": self.eval, "dot": "fail"}})
        canvas = self.client.get(f"{self.base}/chain").json()
        edges = {(e["source"], e["source_handle"], e["target"]) for e in canvas["edges"]}
        self.assertIn((self.eval, "p:fail", self.dedup), edges)
        node = next(n for n in canvas["nodes"] if n["id"] == self.dedup)
        self.assertEqual(node["flow"]["eval_source"], {"box": self.eval, "dot": "fail"})
        flow.connect(CAM, "ingest", self.dedup)
        self.assertIsNone(flow.node_eval_source(flow.load_graph(CAM), self.dedup))

    def test_deleting_the_evaluation_frees_the_boxes_that_read_it(self) -> None:
        flow.update_node(CAM, self.dedup, {"source": {"box": self.eval, "dot": "pass"}})
        self.assertEqual(flow.delete_preview(CAM, self.eval)["arrows"], 1)
        flow.delete_node(CAM, self.eval)
        self.assertIsNone(flow.node_eval_source(flow.load_graph(CAM), self.dedup))
        self.assertEqual(flow.node_frames(CAM, self.dedup), [])

    def test_line_types(self) -> None:
        self.assertIsNone(lines.line_error("evaluation", "dedup"))
        self.assertIsNone(lines.line_error("evaluation", "crop"))
        self.assertIsNone(lines.line_error("evaluation", "detector"))


class EvaluationLabelingTests(ApiTestCase):
    """The Evaluation page labels pictures for the Classifiers that show it."""

    def setUp(self) -> None:
        super().setUp()
        import datamodel  # noqa: PLC0415
        import labels  # noqa: PLC0415
        from roi import ROI  # noqa: PLC0415

        self.frames = write_frames(CAM, 4)
        datamodel.save_rois(CAM, [ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"]), ROI("seal", 0, 0, 1, 1, classes=["OK", "NG"])])
        self.eval = flow.create_node(CAM, "evaluation")
        labels.set_label(CAM, "seal", self.frames[0], "OK")
        labels.mark_golden(CAM, "seal", self.frames[0], "OK")
        verdicts = {f: "pass" for f in self.frames}
        patch = mock.patch.object(flow, "evaluation_state", return_value={"values": {f: 1.0 for f in self.frames}, "verdicts": verdicts, "counts": {"pass": 4, "fail": 0, "undetermined": 0}, "unit": "px", "mode": "tolerance", "zone": None})
        patch.start()
        self.addCleanup(patch.stop)
        self.url = f"/api/cameras/{CAM}/flow/nodes/{self.eval}/labeling"

    def test_no_classifier_shows_the_box_so_there_is_nothing_to_label(self) -> None:
        self.assertEqual(self.client.get(self.url).json(), {"features": [], "feature": None, "classes": [], "marks": {}})

    def test_a_classifier_that_shows_the_box_gives_its_classes_and_the_marks_of_these_pictures(self) -> None:
        flow.set_feature_evaluation(CAM, "seal", self.eval)
        body = self.client.get(self.url).json()
        self.assertEqual(body["features"], ["seal"])
        self.assertEqual(body["classes"], ["OK", "NG"])
        self.assertEqual(body["marks"], {self.frames[0]: {"label": "OK", "golden": "OK"}})

    def test_the_chosen_classifier_decides_and_an_unknown_one_falls_back_to_the_first(self) -> None:
        flow.set_feature_evaluation(CAM, "seal", self.eval)
        flow.set_feature_evaluation(CAM, "type", self.eval)
        self.assertEqual(self.client.get(self.url, params={"feature": "type"}).json()["classes"], ["A", "B"])
        self.assertEqual(self.client.get(self.url, params={"feature": "nope"}).json()["feature"], self.client.get(self.url).json()["features"][0])

    def test_only_an_evaluation_labels(self) -> None:
        det = flow.create_node(CAM, "detector")
        self.assertEqual(self.client.get(f"/api/cameras/{CAM}/flow/nodes/{det}/labeling").status_code, 422)
