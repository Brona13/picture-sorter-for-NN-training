"""Ingest OK / Ingest NG: step 2 starts from the last freeze of step 1 (plan ``plans/two-step-solution.md``, stage 2)."""
from __future__ import annotations

import datamodel
import flow
import labels
import piles
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camX"


class PileTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 8)
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 1, 1, classes=["OK", "NG"])])
        for frame, cls in zip(self.frames[:6], ["OK", "OK", "OK", "NG", "NG", "NG"]):
            labels.set_label(CAM, "seal", frame, cls)
        self.base = f"/api/cameras/{CAM}"
        self.ok = flow.create_node(CAM, "ingest_ok")
        self.ng = flow.create_node(CAM, "ingest_ng")

    def freeze_box(self) -> str:
        box = flow.create_node(CAM, "export")
        for where, dot in (("ok", "OK"), ("ng", "NG")):
            flow.update_node(CAM, box, {"add_line": {"input": where, "ref": {"feature": "seal", "dot": dot}}})
        return box

    def freeze(self, box: str) -> dict:
        return self.client.post(f"{self.base}/flow/nodes/{box}/export/freeze", json={}).json()

    def node(self, node_id: str) -> dict:
        return {n["id"]: n for n in self.client.get(f"{self.base}/chain").json()["nodes"]}[node_id]

    def test_a_pile_is_always_step_two_whatever_step_is_asked(self) -> None:
        nodes = flow.load_graph(CAM)["nodes"]
        self.assertEqual((nodes[self.ok]["kind"], nodes[self.ok]["step"], nodes[self.ng]["step"]), ("ingest_ok", 2, 2))
        asked_step_one = flow.create_node(CAM, "ingest_ng", 1)
        self.assertEqual(flow.load_graph(CAM)["nodes"][asked_step_one]["step"], 2)

    def test_without_a_freeze_module_a_pile_is_empty_and_says_so(self) -> None:
        self.assertEqual(flow.node_frames(CAM, self.ok), [])
        summary = self.node(self.ok)["flow"]
        self.assertEqual((summary["frames"], summary["freeze"], summary["warning"]), (0, None, "Step 1 has no Freeze module."))

    def test_a_freeze_module_that_was_never_frozen_gives_an_empty_pile_with_its_own_warning(self) -> None:
        self.freeze_box()
        summary = self.node(self.ng)["flow"]
        self.assertEqual((summary["frames"], summary["warning"]), (0, "Step 1 is not frozen yet."))

    def test_the_piles_hold_the_ok_and_ng_pictures_of_the_last_freeze(self) -> None:
        box = self.freeze_box()
        self.freeze(box)
        self.assertEqual(flow.node_frames(CAM, self.ok), sorted(self.frames[:3]))
        self.assertEqual(flow.node_frames(CAM, self.ng), sorted(self.frames[3:6]))
        ok = self.node(self.ok)
        self.assertEqual((ok["step"], ok["label"], ok["flow"]["frames"], ok["flow"]["freeze"], ok["flow"]["warning"], ok["flow"]["cls"]), (2, "Ingest OK 1", 3, 1, None, "OK"))
        self.assertEqual(self.node(self.ng)["label"], "Ingest NG 1")

    def test_step_one_changing_after_the_freeze_does_not_move_the_piles_until_it_is_frozen_again(self) -> None:
        box = self.freeze_box()
        self.freeze(box)
        labels.set_label(CAM, "seal", self.frames[0], "NG")  # step 1 changes: f0 is now NG
        self.assertIn(self.frames[0], flow.node_frames(CAM, self.ok))
        self.freeze(box)
        self.assertNotIn(self.frames[0], flow.node_frames(CAM, self.ok))
        self.assertIn(self.frames[0], flow.node_frames(CAM, self.ng))
        self.assertEqual(self.node(self.ok)["flow"]["freeze"], 2)

    def test_a_picture_deleted_since_the_freeze_leaves_the_pile(self) -> None:
        self.freeze(self.freeze_box())
        self.client.post(f"{self.base}/classify/delete", json={"feature": "seal", "frame": self.frames[1]})
        self.assertNotIn(self.frames[1], flow.node_frames(CAM, self.ok))
        self.assertEqual(self.node(self.ok)["flow"]["frames"], 2)

    def test_the_newest_freeze_of_any_freeze_module_counts(self) -> None:
        first = self.freeze_box()
        self.freeze(first)
        second = self.freeze_box()
        flow.update_node(CAM, second, {"remove_line": {"input": "ng", "ref": {"feature": "seal", "dot": "NG"}}})
        self.freeze(second)  # version 2: OK pictures only
        self.assertEqual(piles.last_freeze(CAM)["box"], second)
        self.assertEqual(flow.node_frames(CAM, self.ng), [])

    def test_a_step_two_export_is_not_a_freeze_module(self) -> None:
        two = flow.create_node(CAM, "export", 2)
        self.assertEqual(piles.freeze_boxes(flow.load_graph(CAM)), [])
        self.assertTrue(two)

    def test_a_pile_can_be_deleted_and_lines_into_it_are_refused(self) -> None:
        flow.delete_node(CAM, self.ok)
        self.assertNotIn(self.ok, flow.load_graph(CAM)["nodes"])
        why = flow.edge_allowed(flow.load_graph(CAM), "ingest", self.ng)
        self.assertTrue(why)
