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


class StepTwoClassifierTests(PileTests):
    """A step-2 Classifier takes its class dots from Ingest OK / Ingest NG: the labels come from the last freeze and are final."""

    def setUp(self) -> None:
        super().setUp()
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 1, 1, classes=["OK", "NG"]), ROI("pick", 0.1, 0.1, 0.5, 0.5, classes=["OK", "NG"])])
        self.client.put(f"{self.base}/chain/pick/step", json={"step": 2})
        self.client.put(f"{self.base}/chain/pick/detached", json={"detached": True})
        self.freeze(self.freeze_box())

    def wire(self) -> None:
        for cls, pile in (("OK", self.ok), ("NG", self.ng)):
            r = self.client.put(f"{self.base}/chain/pick/class-lines", json={"cls": cls, "box": pile})
            self.assertEqual(r.status_code, 200, r.text)

    def test_the_step_is_stored_per_classifier_and_shown_on_the_canvas(self) -> None:
        self.assertEqual(flow.roi_step(CAM, "pick"), 2)
        self.assertEqual(flow.roi_step(CAM, "seal"), 1)
        nodes = {n["id"]: n for n in self.client.get(f"{self.base}/chain").json()["nodes"]}
        self.assertEqual((nodes["roi:pick"]["step"], nodes["roi:seal"]["step"]), (2, 1))
        self.assertEqual(self.client.put(f"{self.base}/chain/nope/step", json={"step": 2}).status_code, 404)
        self.assertEqual(self.client.put(f"{self.base}/chain/pick/step", json={"step": 3}).status_code, 422)

    def test_the_piles_label_a_step_two_classifier_with_the_freeze_and_the_labels_are_final(self) -> None:
        self.wire()
        got = labels.current_labels(CAM, "pick")
        self.assertEqual({f: got.get(f) for f in self.frames[:6]}, {**{f: "OK" for f in self.frames[:3]}, **{f: "NG" for f in self.frames[3:6]}})
        self.assertNotIn(self.frames[6], got)  # never frozen: no label
        self.assertEqual(set(datamodel.frames_for_feature(CAM, "pick")), set(self.frames[:6]))
        self.assertTrue(set(self.frames[:6]) <= labels.locked_frames(CAM, "pick"))  # nobody relabels them by hand

    def test_a_pile_only_feeds_its_own_class_dot(self) -> None:
        r = self.client.put(f"{self.base}/chain/pick/class-lines", json={"cls": "NG", "box": self.ok})
        self.assertEqual(r.status_code, 422)
        self.assertIn("holds OK pictures, not NG", r.json()["detail"])

    def test_a_pile_feeds_only_a_step_two_classifier_and_a_step_two_classifier_takes_only_piles(self) -> None:
        r = self.client.put(f"{self.base}/chain/seal/class-lines", json={"cls": "OK", "box": self.ok})
        self.assertEqual(r.status_code, 422)
        self.assertIn("step-2 Classifier", r.json()["detail"])
        dedup = flow.create_node(CAM, "dedup")
        r = self.client.put(f"{self.base}/chain/pick/class-lines", json={"cls": "OK", "box": dedup})
        self.assertEqual(r.status_code, 422)
        self.assertIn("take Ingest OK and Ingest NG", r.json()["detail"])

    def test_deleting_a_classifier_forgets_its_step(self) -> None:
        self.client.delete(f"{self.base}/rois/pick")
        self.assertEqual(flow.roi_step(CAM, "pick"), 1)

    # The pile tests of the parent class run once, in PileTests.
    test_a_pile_is_always_step_two_whatever_step_is_asked = None
    test_without_a_freeze_module_a_pile_is_empty_and_says_so = None
    test_a_freeze_module_that_was_never_frozen_gives_an_empty_pile_with_its_own_warning = None
    test_the_piles_hold_the_ok_and_ng_pictures_of_the_last_freeze = None
    test_step_one_changing_after_the_freeze_does_not_move_the_piles_until_it_is_frozen_again = None
    test_a_picture_deleted_since_the_freeze_leaves_the_pile = None
    test_the_newest_freeze_of_any_freeze_module_counts = None
    test_a_step_two_export_is_not_a_freeze_module = None
    test_a_pile_can_be_deleted_and_lines_into_it_are_refused = None
