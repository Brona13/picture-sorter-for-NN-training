"""The Merge box: many lines of one meaning (OK, NG, a class...) in, one line out (v1.123.0)."""
from __future__ import annotations

import datamodel
import export_box
import flow
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camM"


class MergeBoxTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 8)
        datamodel.save_rois(CAM, [
            ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"]),
            ROI("h1", 0, 0, 1, 1, classes=["OK", "NG"]),
            ROI("h2", 0, 0, 1, 1, classes=["OK", "NG"]),
        ])
        f = self.frames
        for frame, cls in zip(f[:6], ["OK", "OK", "OK", "NG", "NG", "NG"]):
            labels.set_label(CAM, "h1", frame, cls)
        for frame, cls in zip(f[:6], ["OK", "NG", "OK", "OK", "NG", "NG"]):
            labels.set_label(CAM, "h2", frame, cls)
        self.merge = flow.create_node(CAM, "merge")
        self.base = f"/api/cameras/{CAM}"

    def add(self, ref: dict, box: str | None = None) -> None:
        flow.update_node(CAM, box or self.merge, {"add_line": ref})

    def frames_of(self, box: str | None = None) -> set[str]:
        return set(flow.node_frames(CAM, box or self.merge))

    def meaning(self, box: str | None = None):
        return flow.merge_meaning(flow.load_graph(CAM), box or self.merge)

    def test_a_new_merge_is_neutral_and_the_first_line_sets_its_meaning(self) -> None:
        self.assertEqual(flow.kind_of(self.merge), "merge")
        self.assertIsNone(self.meaning())
        self.assertEqual(self.frames_of(), set())
        self.add({"feature": "h1", "dot": "OK"})
        self.assertEqual(self.meaning(), "OK")

    def test_a_line_of_another_meaning_is_refused_with_the_reason(self) -> None:
        self.add({"feature": "h1", "dot": "OK"})
        with self.assertRaises(flow.FlowError) as ctx:
            self.add({"feature": "h2", "dot": "NG"})
        self.assertIn("collects OK", str(ctx.exception))
        self.add({"feature": "h2", "dot": "OK"})  # the same meaning from another Classifier is fine
        self.assertEqual(len(flow.merge_lines(flow.load_graph(CAM)["nodes"][self.merge])), 2)

    def test_removing_every_line_makes_it_neutral_again_and_the_other_meaning_is_accepted(self) -> None:
        self.add({"feature": "h1", "dot": "OK"})
        flow.update_node(CAM, self.merge, {"remove_line": {"feature": "h1", "dot": "OK"}})
        self.assertIsNone(self.meaning())
        self.add({"feature": "h1", "dot": "NG"})
        self.assertEqual(self.meaning(), "NG")

    def test_an_evaluation_pass_is_ok_and_fail_is_ng_and_all_dots_have_no_meaning(self) -> None:
        ev = flow.create_node(CAM, "evaluation")
        self.add({"box": ev, "dot": "pass"})
        self.assertEqual(self.meaning(), "OK")
        with self.assertRaises(flow.FlowError):
            self.add({"box": ev, "dot": "fail"})
        other = flow.create_node(CAM, "merge")
        for bad in ({"feature": "h1", "dot": "all"}, {"box": ev, "dot": "all"}, {"from": "ingest"}):
            with self.assertRaises(flow.FlowError):
                self.add(bad, other)
        self.assertIsNone(self.meaning(other))

    def test_any_is_the_union_and_all_the_intersection(self) -> None:
        f = self.frames
        self.add({"feature": "h1", "dot": "OK"})  # f0 f1 f2
        self.add({"feature": "h2", "dot": "OK"})  # f0 f2 f3
        self.assertEqual(self.frames_of(), {f[0], f[1], f[2], f[3]})
        flow.update_node(CAM, self.merge, {"mode": "all"})
        self.assertEqual(self.frames_of(), {f[0], f[2]})
        with self.assertRaises(flow.FlowError):
            flow.update_node(CAM, self.merge, {"mode": "most"})

    def test_deleted_pictures_never_pass(self) -> None:
        import db
        self.add({"feature": "h1", "dot": "OK"})
        db.mark_frames_deleted(CAM, [(self.frames[0], db.frame_hash_map(CAM)[self.frames[0]])])
        self.assertNotIn(self.frames[0], self.frames_of())

    def test_one_merge_line_fills_an_export_input_where_nine_lines_would_intersect_to_nothing(self) -> None:
        f = self.frames
        export = flow.create_node(CAM, "export")
        flow.update_node(CAM, export, {"goldens_only": False})
        for frame, product in zip(f[:6], ["A", "A", "A", "B", "B", "B"]):
            labels.set_label(CAM, "type", frame, product)
        self.add({"feature": "h1", "dot": "OK"})
        self.add({"feature": "h2", "dot": "OK"})
        flow.update_node(CAM, export, {"add_line": {"input": "ok", "ref": {"from": self.merge}}})
        got = export_box.selection(CAM, export)["ok"]
        self.assertEqual(got, {f[0], f[1], f[2], f[3]})
        with self.assertRaises(flow.FlowError) as ctx:  # an OK merge into the NG input is refused
            flow.update_node(CAM, export, {"add_line": {"input": "ng", "ref": {"from": self.merge}}})
        self.assertIn("collects OK", str(ctx.exception))

    def test_a_merge_feeds_a_detector_and_another_merge(self) -> None:
        f = self.frames
        self.add({"feature": "h1", "dot": "OK"})
        det = flow.create_node(CAM, "detector")
        flow.connect(CAM, self.merge, det)
        self.assertEqual(set(flow.node_frames(CAM, det)), {f[0], f[1], f[2]})
        outer = flow.create_node(CAM, "merge")
        self.add({"from": self.merge}, outer)
        self.assertEqual(self.meaning(outer), "OK")
        self.assertEqual(self.frames_of(outer), {f[0], f[1], f[2]})

    def test_a_merge_cannot_read_itself_or_its_own_reader(self) -> None:
        self.add({"feature": "h1", "dot": "OK"})
        outer = flow.create_node(CAM, "merge")
        self.add({"from": self.merge}, outer)
        with self.assertRaises(flow.FlowError) as ctx:
            self.add({"from": outer}, self.merge)  # the Merge that reads this one cannot feed it back
        self.assertIn("loop", str(ctx.exception))
        with self.assertRaises(flow.FlowError):
            self.add({"from": outer}, outer)  # nor itself

    def test_the_chain_draws_one_line_per_dot_and_summarises_the_merge(self) -> None:
        self.add({"feature": "h1", "dot": "OK"})
        self.add({"feature": "h2", "dot": "OK"})
        canvas = self.client.get(f"{self.base}/chain").json()
        edges = {(e["source"], e["source_handle"], e["target"]) for e in canvas["edges"]}
        self.assertIn(("roi:h1", "p:OK", self.merge), edges)
        self.assertIn(("roi:h2", "p:OK", self.merge), edges)
        node = next(n for n in canvas["nodes"] if n["id"] == self.merge)
        self.assertEqual((node["kind"], node["label"]), ("merge", "Merge 1"))
        self.assertEqual(node["flow"], {"meaning": "OK", "merge_mode": "any", "inputs": 2, "frames": 4})

    def test_deleting_a_box_a_line_came_from_cuts_the_line_and_the_preview_counts_it(self) -> None:
        ev = flow.create_node(CAM, "evaluation")
        self.add({"box": ev, "dot": "pass"})
        self.assertEqual(flow.delete_preview(CAM, ev)["arrows"], 1)
        flow.delete_node(CAM, ev)
        self.assertEqual(flow.merge_lines(flow.load_graph(CAM)["nodes"][self.merge]), [])

    def test_the_merge_detail_and_the_edge_rules(self) -> None:
        self.add({"feature": "h1", "dot": "OK"})
        detail = self.client.get(f"{self.base}/flow/nodes/{self.merge}").json()
        self.assertEqual((detail["kind"], detail["mode"], detail["meaning"]), ("merge", "any", "OK"))
        dedup = flow.create_node(CAM, "dedup")
        calc = flow.create_node(CAM, "calc")
        graph = flow.load_graph(CAM)
        self.assertIsNone(flow.edge_allowed(graph, self.merge, dedup))
        self.assertIn("A Merge gives frames or a picture, but Calculate takes", flow.edge_allowed(graph, self.merge, calc) or "")
        self.assertIsNotNone(flow.edge_allowed(graph, "ingest", self.merge))  # lines into a Merge are dots, drawn from a Classifier or Evaluation
