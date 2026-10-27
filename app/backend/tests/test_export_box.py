"""The Export box: two inputs (OK / NG), lines combined by intersection, golden pictures, product folders, freeze then export."""
from __future__ import annotations

import datamodel
import export_box
import flow
import labels
import versions
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camX"


class ExportBoxTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 8)
        datamodel.save_rois(CAM, [
            ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"]),
            ROI("seal", 0, 0, 1, 1, classes=["OK", "NG"]),
        ])
        f = self.frames
        for frame, cls in zip(f[:6], ["OK", "OK", "OK", "NG", "NG", "NG"]):
            labels.set_label(CAM, "seal", frame, cls)
        for frame in (f[0], f[1], f[3], f[4]):  # goldens; f[2] and f[5] are labeled only
            labels.mark_golden(CAM, "seal", frame, labels.current_labels(CAM, "seal")[frame])
        for frame, product in zip(f[:6], ["A", "A", "B", "A", "B", "B"]):
            labels.set_label(CAM, "type", frame, product)
        self.box = flow.create_node(CAM, "export")
        self.base = f"/api/cameras/{CAM}"

    def line(self, where: str, ref: dict) -> None:
        flow.update_node(CAM, self.box, {"add_line": {"input": where, "ref": ref}})

    def wire(self) -> None:
        self.line("ok", {"feature": "seal", "dot": "OK"})
        self.line("ng", {"feature": "seal", "dot": "NG"})

    def test_lines_are_stored_once_and_a_bad_line_is_refused(self) -> None:
        self.line("ok", {"feature": "seal", "dot": "OK"})
        self.line("ok", {"feature": "seal", "dot": "OK"})
        self.assertEqual(flow.export_lines(flow.load_graph(CAM), self.box)["ok"], [{"feature": "seal", "dot": "OK"}])
        for bad in ({"feature": "nope", "dot": "OK"}, {"feature": "seal", "dot": "MAYBE"}, {"box": "eval:9", "dot": "pass"}, {"from": "calc:1"}, "text"):
            with self.assertRaises(flow.FlowError):
                self.line("ok", bad)
        with self.assertRaises(flow.FlowError):
            self.line("maybe", {"feature": "seal", "dot": "OK"})
        flow.update_node(CAM, self.box, {"remove_line": {"input": "ok", "ref": {"feature": "seal", "dot": "OK"}}})
        self.assertEqual(flow.export_lines(flow.load_graph(CAM), self.box)["ok"], [])
        with self.assertRaises(flow.FlowError):
            flow.update_node(CAM, self.box, {"remove_line": {"input": "ok", "ref": {"feature": "seal", "dot": "OK"}}})

    def test_lines_into_one_input_are_intersected(self) -> None:
        self.line("ok", {"feature": "seal", "dot": "OK"})  # f0 f1 f2
        self.line("ok", {"feature": "type", "dot": "A"})   # f0 f1 f3
        self.assertEqual(export_box.selection(CAM, self.box)["ok"], {self.frames[0], self.frames[1]})
        self.assertIsNone(export_box.selection(CAM, self.box)["ng"])  # an input with no line is not used

    def test_only_goldens_with_the_product_folder_and_the_counts_that_explain_the_rest(self) -> None:
        self.wire()
        p = export_box.plan(CAM, self.box)
        f = self.frames
        self.assertEqual(sorted(p["items"]), sorted([(f[0], "A/OK"), (f[1], "A/OK"), (f[3], "A/NG"), (f[4], "B/NG")]))
        self.assertEqual(p["not_golden"], 2)  # f2 and f5 are labeled but not golden
        self.assertEqual(p["folders"], {"A/NG": 1, "A/OK": 2, "B/NG": 1})
        self.assertTrue(p["uses_product"])

    def test_goldens_only_can_be_switched_off_and_a_picture_without_a_product_is_left_out_and_counted(self) -> None:
        self.wire()
        flow.update_node(CAM, self.box, {"goldens_only": False})
        labels.set_label(CAM, "type", self.frames[2], None)  # f2 has no product now
        p = export_box.plan(CAM, self.box)
        self.assertEqual(p["no_product"], 1)
        self.assertNotIn(self.frames[2], [f for f, _ in p["items"]])
        self.assertEqual(len(p["items"]), 5)

    def test_without_a_product_classifier_the_folders_are_just_ok_and_ng(self) -> None:
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 1, 1, classes=["OK", "NG"])])
        self.wire()
        p = export_box.plan(CAM, self.box)
        self.assertEqual(p["folders"], {"NG": 2, "OK": 2})
        self.assertFalse(p["uses_product"])

    def test_a_picture_on_both_inputs_is_left_out_and_reported(self) -> None:
        self.line("ok", {"feature": "seal", "dot": "all"})
        self.line("ng", {"feature": "seal", "dot": "all"})
        p = export_box.plan(CAM, self.box)
        self.assertEqual(p["items"], [])
        self.assertEqual(p["both"], 6)

    def test_a_whole_box_and_ingest_can_feed_an_input(self) -> None:
        self.line("ok", {"from": "ingest"})
        self.line("ok", {"feature": "seal", "dot": "OK"})
        self.assertEqual(export_box.selection(CAM, self.box)["ok"], set(self.frames[:3]))

    def test_deleted_pictures_never_arrive(self) -> None:
        self.line("ok", {"feature": "seal", "dot": "OK"})
        self.client.post(f"{self.base}/classify/delete", json={"feature": "seal", "frame": self.frames[0]})
        self.assertNotIn(self.frames[0], export_box.selection(CAM, self.box)["ok"])

    def test_freeze_then_export_writes_the_originals_into_product_folders(self) -> None:
        self.wire()
        body = self.client.post(f"{self.base}/flow/nodes/{self.box}/export/freeze", json={"name": "first"}).json()
        self.assertEqual(body["counts"]["ok"], 2)
        self.assertEqual(body["counts"]["ng"], 2)
        report = self.client.post(f"{self.base}/project-versions/{body['id']}/export").json()
        self.assertEqual(report["written"], 4)
        dest = versions.export_dir(CAM, body["number"], "first")
        self.assertTrue((dest / "A" / "OK" / self.frames[0]).exists())
        self.assertTrue((dest / "B" / "NG" / self.frames[4]).exists())
        self.assertFalse((dest / "OK").exists())

    def test_the_state_says_when_the_chain_would_pick_other_pictures_than_the_last_freeze(self) -> None:
        self.wire()
        self.assertIsNone(self.client.get(f"{self.base}/flow/nodes/{self.box}/export").json()["latest"])
        self.client.post(f"{self.base}/flow/nodes/{self.box}/export/freeze", json={})
        latest = self.client.get(f"{self.base}/flow/nodes/{self.box}/export").json()["latest"]
        self.assertFalse(latest["changed"])
        self.assertFalse(latest["exported"])
        labels.mark_golden(CAM, "seal", self.frames[2], "OK")  # one more golden: the chain now picks another set
        self.assertTrue(self.client.get(f"{self.base}/flow/nodes/{self.box}/export").json()["latest"]["changed"])

    def test_nothing_to_freeze_is_refused_with_a_reason(self) -> None:
        r = self.client.post(f"{self.base}/flow/nodes/{self.box}/export/freeze", json={})
        self.assertEqual(r.status_code, 422)
        self.assertIn("connect lines", r.json()["detail"])

    def test_only_an_export_box_has_this_page(self) -> None:
        det = flow.create_node(CAM, "detector")
        self.assertEqual(self.client.get(f"{self.base}/flow/nodes/{det}/export").status_code, 422)

    def test_the_chain_draws_the_lines_into_the_two_inputs_and_summarises_the_box(self) -> None:
        self.wire()
        canvas = self.client.get(f"{self.base}/chain").json()
        edges = {(e["source"], e["source_handle"], e["target"], e.get("target_handle")) for e in canvas["edges"]}
        self.assertIn(("roi:seal", "p:OK", self.box, "in:ok"), edges)
        self.assertIn(("roi:seal", "p:NG", self.box, "in:ng"), edges)
        node = next(n for n in canvas["nodes"] if n["id"] == self.box)
        self.assertEqual(node["kind"], "export")
        self.assertEqual(node["flow"]["total"], 4)
        self.assertEqual(node["flow"]["lines"], {"ok": 1, "ng": 1})

    def test_deleting_a_box_a_line_came_from_cuts_the_line(self) -> None:
        ev = flow.create_node(CAM, "evaluation")
        self.line("ok", {"box": ev, "dot": "pass"})
        self.assertEqual(flow.delete_preview(CAM, ev)["arrows"], 1)
        flow.delete_node(CAM, ev)
        self.assertEqual(flow.export_lines(flow.load_graph(CAM), self.box)["ok"], [])
