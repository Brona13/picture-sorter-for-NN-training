"""Lines into a Classifier's class dots: Evaluation pass / fail and Dedup boxes give pictures a class (temporary roots only)."""
from __future__ import annotations

from unittest import mock

import class_lines
import datamodel
import db
import flow
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camCL"


class ClassLineTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 8)
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 1, 1, role="classify", classes=["OK", "NG", "Other"])])
        self.eval = flow.create_node(CAM, "evaluation")
        self.dedup = flow.create_node(CAM, "dedup")
        f = self.frames
        verdicts = {**{x: "pass" for x in f[:5]}, **{x: "fail" for x in f[5:7]}}  # the last picture was not measured
        patcher = mock.patch.object(flow, "evaluation_state", return_value={"verdicts": verdicts, "unit": "px", "mode": "tolerance", "zone": None, "counts": {"pass": 5, "fail": 2, "undetermined": 1}})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.base = f"/api/cameras/{CAM}"

    def put(self, cls: str, box: str, dot: str | None = None, remove: bool = False):
        return self.client.put(f"{self.base}/chain/seal/class-lines", json={"cls": cls, "box": box, "dot": dot, "remove": remove})

    def test_pass_through_dedup_into_ok_and_fail_into_ng(self) -> None:
        flow.update_node(CAM, self.dedup, {"source": {"box": self.eval, "dot": "pass"}})
        db.add_dedup_mutes(CAM, self.dedup, [(self.frames[0], db.frame_hash_for(CAM, self.frames[0]), 1)])
        self.assertEqual(self.put("OK", self.dedup).status_code, 200)
        self.assertEqual(self.put("NG", self.eval, "fail").status_code, 200)
        cur = labels.current_labels(CAM, "seal")
        self.assertEqual(sorted(f for f, c in cur.items() if c == "OK"), sorted(self.frames[1:5]))
        self.assertEqual(sorted(f for f, c in cur.items() if c == "NG"), sorted(self.frames[5:7]))
        node = next(n for n in self.client.get(f"{self.base}/chain").json()["nodes"] if n["id"] == "roi:seal")
        self.assertEqual((node["frames"], node["labeled"], node["unlabeled"]), (6, 6, 0))  # the muted picture and the unmeasured one are not counted
        self.assertEqual(node["product_counts"]["OK"], 4)

    def test_a_dot_refuses_a_source_of_another_class_or_without_one(self) -> None:
        self.assertEqual(self.put("OK", self.eval, "fail").status_code, 422)
        self.assertEqual(self.put("OK", self.eval, "all").status_code, 422)
        flow.connect(CAM, "ingest", self.dedup)
        self.assertEqual(self.put("OK", self.dedup).status_code, 422)  # reads Ingest: no class to give
        flow.update_node(CAM, self.dedup, {"source": {"box": self.eval, "dot": "fail"}})
        self.assertEqual(self.put("OK", self.dedup).status_code, 422)
        self.assertEqual(self.put("NG", self.dedup).status_code, 200)

    def test_a_picture_on_two_dots_is_left_out(self) -> None:
        self.put("OK", self.eval, "pass")
        dedup2 = flow.create_node(CAM, "dedup")
        flow.update_node(CAM, dedup2, {"source": {"box": self.eval, "dot": "pass"}})
        self.assertEqual(self.put("NG", self.eval, "fail").status_code, 200)
        self.assertEqual(class_lines.conflicts(CAM, "seal"), set())
        self.assertEqual(class_lines.scope(CAM, "seal"), set(self.frames[:7]))

    def test_removing_a_line_keeps_its_labels_as_hand_labels(self) -> None:
        self.put("OK", self.eval, "pass")
        self.assertEqual(self.put("OK", self.eval, "pass", remove=True).status_code, 200)
        self.assertEqual(len(labels.current_labels(CAM, "seal")), 5)
        self.assertEqual(class_lines.get(CAM, "seal"), [])

    def test_deleting_the_box_drops_its_lines(self) -> None:
        self.put("OK", self.eval, "pass")
        flow.delete_node(CAM, self.eval)
        self.assertEqual(class_lines.get(CAM, "seal"), [])

    def test_the_chain_draws_the_line_into_the_class_dot(self) -> None:
        self.put("NG", self.eval, "fail")
        edges = self.client.get(f"{self.base}/chain").json()["edges"]
        self.assertTrue(any(e["source"] == self.eval and e["source_handle"] == "p:fail" and e["target"] == "roi:seal" and e["target_handle"] == "in:NG" for e in edges))


class CanvasWorkedOutOnceTests(ApiTestCase):
    """One Chain load works out each Evaluation's verdicts, each class-line scope and each Dedup box's pictures once (v1.128.0)."""

    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames("camOnce", 8)
        datamodel.save_rois("camOnce", [ROI("seal", 0, 0, 1, 1, role="classify", classes=["OK", "NG"])])
        self.eval = flow.create_node("camOnce", "evaluation")
        self.dedup = flow.create_node("camOnce", "dedup")
        verdicts = {**{f: "pass" for f in self.frames[:5]}, **{f: "fail" for f in self.frames[5:7]}}
        self.state = {"verdicts": verdicts, "unit": "px", "mode": "tolerance", "zone": None, "counts": {"pass": 5, "fail": 2, "undetermined": 1}}
        flow.update_node("camOnce", self.dedup, {"source": {"box": self.eval, "dot": "pass"}})
        class_lines.add("camOnce", "seal", "OK", self.dedup)
        class_lines.add("camOnce", "seal", "NG", self.eval, "fail")

    def test_the_canvas_asks_each_evaluation_and_scope_once_and_gives_the_same_numbers(self) -> None:
        with mock.patch.object(flow, "_evaluation_state", return_value=self.state) as state, \
                mock.patch.object(class_lines, "_by_class", wraps=class_lines._by_class) as scope:
            nodes = self.client.get("/api/cameras/camOnce/chain").json()["nodes"]
        self.assertEqual(state.call_count, 1)
        self.assertEqual(scope.call_count, 1)
        seal = next(n for n in nodes if n["id"] == "roi:seal")
        self.assertEqual(seal["frames"], 7)  # the pictures the two class dots give (the unmeasured one is not among them)

    def test_outside_a_canvas_nothing_is_remembered(self) -> None:
        with mock.patch.object(flow, "_evaluation_state", return_value=self.state) as state:
            flow.evaluation_state("camOnce", self.eval)
            flow.evaluation_state("camOnce", self.eval)
        self.assertEqual(state.call_count, 2)
