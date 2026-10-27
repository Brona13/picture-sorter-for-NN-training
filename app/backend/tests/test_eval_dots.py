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
        datamodel.save_rois(CAM, [ROI("type", 0, 0, 1, 1, role="classify", classes=["OK", "NG", "Maybe"]), ROI("seal", 0, 0, 1, 1, classes=["OK", "NG"])])
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
        # the verdicts are the labels now (all four pass = OK); the golden that was there stays
        self.assertEqual(body["marks"], {f: {"label": "OK", "golden": "OK" if f == self.frames[0] else None} for f in self.frames})

    def test_the_chosen_classifier_decides_and_an_unknown_one_falls_back_to_the_first(self) -> None:
        flow.set_feature_evaluation(CAM, "seal", self.eval)
        flow.set_feature_evaluation(CAM, "type", self.eval)
        self.assertEqual(self.client.get(self.url, params={"feature": "type"}).json()["classes"], ["OK", "NG", "Maybe"])
        self.assertEqual(self.client.get(self.url, params={"feature": "nope"}).json()["feature"], self.client.get(self.url).json()["features"][0])

    def test_only_an_evaluation_labels(self) -> None:
        det = flow.create_node(CAM, "detector")
        self.assertEqual(self.client.get(f"/api/cameras/{CAM}/flow/nodes/{det}/labeling").status_code, 422)


class EvaluationLabelsTests(ApiTestCase):
    """A Classifier wired to an Evaluation is labeled by its verdicts (pass = OK, fail = NG); only Goldens are chosen."""

    def setUp(self) -> None:
        super().setUp()
        import datamodel  # noqa: PLC0415
        import labels  # noqa: PLC0415
        from roi import ROI  # noqa: PLC0415

        self.labels = labels
        self.frames = write_frames(CAM, 5)
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 1, 1, classes=["OK", "NG"]), ROI("odd", 0, 0, 1, 1, classes=["A", "B"])])
        self.eval = flow.create_node(CAM, "evaluation")
        self.verdicts = {self.frames[0]: "pass", self.frames[1]: "fail", self.frames[2]: "undetermined", self.frames[3]: "pass"}
        patch = mock.patch.object(flow, "evaluation_state", side_effect=lambda *_: {"verdicts": dict(self.verdicts), "values": {}, "counts": {}, "unit": "", "mode": "tolerance", "zone": None})
        patch.start()
        self.addCleanup(patch.stop)
        self.base = f"/api/cameras/{CAM}"

    def current(self) -> dict[str, str]:
        return self.labels.current_labels(CAM, "seal")

    def test_wiring_labels_pass_ok_and_fail_ng_and_leaves_the_unjudged_alone(self) -> None:
        self.labels.set_label(CAM, "seal", self.frames[4], "NG")  # a hand label on a picture without a verdict stays
        flow.set_feature_evaluation(CAM, "seal", self.eval)
        self.assertEqual(self.current(), {self.frames[0]: "OK", self.frames[1]: "NG", self.frames[3]: "OK", self.frames[4]: "NG"})

    def test_a_hand_label_on_a_judged_picture_is_replaced(self) -> None:
        self.labels.set_label(CAM, "seal", self.frames[0], "NG")
        flow.set_feature_evaluation(CAM, "seal", self.eval)
        self.assertEqual(self.current()[self.frames[0]], "OK")

    def test_the_classes_must_be_ok_and_ng(self) -> None:
        with self.assertRaises(flow.FlowError):
            flow.set_feature_evaluation(CAM, "odd", self.eval)
        self.assertIsNone(flow.feature_evaluation(CAM, "odd"))

    def test_verdict_labels_cannot_be_changed_by_hand_but_goldens_can_be_chosen(self) -> None:
        flow.set_feature_evaluation(CAM, "seal", self.eval)
        put = lambda body: self.client.put(f"{self.base}/classify/label", json={"feature": "seal", **body})  # noqa: E731
        self.assertEqual(put({"frame": self.frames[0], "cls": "NG"}).status_code, 409)
        self.assertEqual(put({"frame": self.frames[0], "cls": None}).status_code, 409)
        bulk = self.client.post(f"{self.base}/classify/label-bulk", json={"feature": "seal", "frames": [self.frames[0], self.frames[1]], "cls": "NG"})
        self.assertEqual(bulk.json()["labeled"], 0)
        self.assertEqual(self.current()[self.frames[0]], "OK")
        golden = self.client.put(f"{self.base}/classify/golden", json={"feature": "seal", "frame": self.frames[0], "golden": True})
        self.assertEqual(golden.status_code, 200)
        self.assertEqual(self.labels.current_goldens(CAM, "seal"), {"OK": [self.frames[0]]})

    def test_the_labels_follow_the_verdicts_when_the_classifier_is_read(self) -> None:
        flow.set_feature_evaluation(CAM, "seal", self.eval)
        self.verdicts[self.frames[0]] = "fail"  # the tolerance changed
        self.verdicts[self.frames[3]] = "undetermined"
        self.client.get(f"{self.base}/classify/state", params={"feature": "seal"})
        self.assertEqual(self.current(), {self.frames[0]: "NG", self.frames[1]: "NG"})

    def test_removing_the_line_keeps_the_labels_and_goldens_as_hand_labels(self) -> None:
        flow.set_feature_evaluation(CAM, "seal", self.eval)
        self.labels.mark_golden(CAM, "seal", self.frames[0], "OK")
        flow.set_feature_evaluation(CAM, "seal", None)
        self.assertEqual(self.current()[self.frames[0]], "OK")
        self.assertEqual(self.labels.current_goldens(CAM, "seal"), {"OK": [self.frames[0]]})
        self.assertEqual(self.client.put(f"{self.base}/classify/label", json={"feature": "seal", "frame": self.frames[0], "cls": "NG"}).status_code, 200)

    def test_the_chain_draws_the_line_from_the_all_dot(self) -> None:
        flow.set_feature_evaluation(CAM, "seal", self.eval)
        edges = {(e["source"], e["source_handle"], e["target"]) for e in self.client.get(f"{self.base}/chain").json()["edges"]}
        self.assertIn((self.eval, lines.ALL_DOT, "roi:seal"), edges)
