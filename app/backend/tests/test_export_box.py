"""The Export box: two inputs (OK / NG), lines combined by intersection, golden pictures, product folders, freeze then export.

The tests below make the step-2 Export (goldens, product folders); ``FreezeTests`` covers the same box in step 1, the Freeze module."""
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
        self.box = flow.create_node(CAM, "export", 2)  # step 2: the goldens Export
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

    def test_the_state_lists_every_freeze_of_the_box_newest_first(self) -> None:
        self.wire()
        url = f"{self.base}/flow/nodes/{self.box}/export"
        self.assertEqual(self.client.get(url).json()["versions"], [])
        first = self.client.post(f"{url}/freeze", json={"name": "first"}).json()
        self.client.post(f"{self.base}/project-versions/{first['id']}/export")
        labels.mark_golden(CAM, "seal", self.frames[2], "OK")  # the chain now picks another set than the first freeze
        self.client.post(f"{url}/freeze", json={"name": "second"})
        state = self.client.get(url).json()
        rows = state["versions"]
        self.assertEqual([r["name"] for r in rows], ["second", "first"])
        self.assertEqual(state["latest"]["number"], rows[0]["number"])
        self.assertEqual([r["exported"] for r in rows], [False, True])
        self.assertTrue(all(r["folder"].endswith(f"v{r['number']:03d}__{r['name']}") for r in rows))
        self.assertEqual([r["changed"] for r in rows], [False, False])  # only the newest is compared with the Chain
        self.assertEqual(rows[1]["counts"]["ok"], 2)
        labels.mark_golden(CAM, "seal", self.frames[5], "NG")
        self.assertEqual([r["changed"] for r in self.client.get(url).json()["versions"]], [True, False])

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
        self.assertEqual((node["flow"]["goldens_only"], node["flow"]["not_golden"]), (True, 2))  # the box says why pictures are left out (v1.122.0)

    def test_deleting_a_box_a_line_came_from_cuts_the_line(self) -> None:
        ev = flow.create_node(CAM, "evaluation")
        self.line("ok", {"box": ev, "dot": "pass"})
        self.assertEqual(flow.delete_preview(CAM, ev)["arrows"], 1)
        flow.delete_node(CAM, ev)
        self.assertEqual(flow.export_lines(flow.load_graph(CAM), self.box)["ok"], [])


class FreezeTests(ApiTestCase):
    """The step-1 box (``step`` 1) is the Freeze module: every OK / NG picture, no goldens, no product folders."""

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
        for frame in (f[0], f[3]):  # two goldens; the others are labeled only
            labels.mark_golden(CAM, "seal", frame, labels.current_labels(CAM, "seal")[frame])
        for frame, product in zip(f[:6], ["A", "A", "B", "A", "B", "B"]):
            labels.set_label(CAM, "type", frame, product)
        self.box = flow.create_node(CAM, "export")  # step 1 is the default
        self.base = f"/api/cameras/{CAM}"
        for where, dot in (("ok", "OK"), ("ng", "NG")):
            flow.update_node(CAM, self.box, {"add_line": {"input": where, "ref": {"feature": "seal", "dot": dot}}})

    def test_the_new_box_defaults_to_step_one_and_a_step_two_box_says_so(self) -> None:
        self.assertNotIn("step", flow.load_graph(CAM)["nodes"][self.box])
        self.assertEqual(flow.step_of(flow.load_graph(CAM)["nodes"][self.box]), 1)
        two = flow.create_node(CAM, "export", 2)
        self.assertEqual(flow.load_graph(CAM)["nodes"][two]["step"], 2)
        with self.assertRaises(flow.FlowError):
            flow.create_node(CAM, "export", 3)

    def test_freeze_takes_every_labeled_picture_without_goldens_and_without_product_folders(self) -> None:
        flow.update_node(CAM, self.box, {"goldens_only": True})  # an older graph may have stored the tick: it does not count in step 1
        p = export_box.plan(CAM, self.box)
        self.assertEqual(sorted(p["items"]), sorted([(f, "OK") for f in self.frames[:3]] + [(f, "NG") for f in self.frames[3:6]]))
        self.assertEqual((p["not_golden"], p["no_product"]), (0, 0))
        self.assertFalse(p["goldens_only"])
        self.assertFalse(p["uses_product"])
        self.assertEqual(p["folders"], {"NG": 3, "OK": 3})

    def test_a_freeze_stores_the_whole_ok_ng_split(self) -> None:
        body = self.client.post(f"{self.base}/flow/nodes/{self.box}/export/freeze", json={"name": "step one"}).json()
        self.assertEqual((body["counts"]["ok"], body["counts"]["ng"], body["counts"]["total"]), (3, 3, 6))
        self.assertEqual({(i["frame"], i["class"]) for i in versions.load_items(body["id"])}, {(f, "OK") for f in self.frames[:3]} | {(f, "NG") for f in self.frames[3:6]})

    def test_the_canvas_names_it_freeze_and_marks_the_step(self) -> None:
        nodes = {n["id"]: n for n in self.client.get(f"{self.base}/chain").json()["nodes"]}
        self.assertEqual((nodes[self.box]["label"], nodes[self.box]["step"]), ("Freeze 1", 1))
        self.assertFalse(nodes[self.box]["flow"]["goldens_only"])
        two = flow.create_node(CAM, "export", 2)
        nodes = {n["id"]: n for n in self.client.get(f"{self.base}/chain").json()["nodes"]}
        self.assertEqual((nodes[two]["label"], nodes[two]["step"]), ("Export 2", 2))

    def test_a_line_stays_inside_its_step(self) -> None:
        det_two = flow.create_node(CAM, "detector", 2)
        det_one = flow.create_node(CAM, "detector")
        graph = flow.load_graph(CAM)
        self.assertIn("step 1 and step 2", flow.edge_allowed(graph, "ingest", det_two) or "")
        self.assertIsNone(flow.edge_allowed(graph, "ingest", det_one))

    def test_the_api_creates_a_step_two_box(self) -> None:
        made = self.client.post(f"{self.base}/flow/nodes", json={"kind": "export", "step": 2})
        self.assertEqual(made.status_code, 201)
        self.assertEqual(flow.load_graph(CAM)["nodes"][made.json()["id"]]["step"], 2)
