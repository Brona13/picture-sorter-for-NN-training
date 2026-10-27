"""Dedup boxes on the Chain: mutes per box, input from Ingest / Picture edits / a Classifier dot, Classifier read through a box."""
from __future__ import annotations

import datamodel
import db
import dedup_box
import flow
import labels
import lines
import roi_input
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camD"


class DedupBoxTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 6)
        datamodel.save_rois(CAM, [
            ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"]),
            ROI("seal", 0, 0, 1, 1),
        ])
        for f, cls in zip(self.frames[:4], ["A", "A", "B", "B"]):  # the last two stay unlabeled
            labels.set_label(CAM, "type", f, cls)
        self.d1 = flow.create_node(CAM, "dedup")
        self.d2 = flow.create_node(CAM, "dedup")
        self.base = f"/api/cameras/{CAM}"

    def mute(self, box: str, frames: list[str]) -> None:
        db.add_dedup_mutes(CAM, box, [(f, db.frame_hash_for(CAM, f), 1) for f in frames])

    def canvas(self) -> dict:
        return self.client.get(f"{self.base}/chain").json()

    def node(self, node_id: str) -> dict:
        return next(n for n in self.canvas()["nodes"] if n["id"] == node_id)

    def edges(self) -> set[tuple]:
        return {(e["source"], e["source_handle"], e["target"]) for e in self.canvas()["edges"]}

    def test_a_box_without_a_line_has_no_pictures_and_one_from_ingest_gives_the_whole_camera(self) -> None:
        self.assertEqual(dedup_box.frames(CAM, self.d1), [])
        self.assertEqual(self.node(self.d1)["flow"]["frames"], 0)
        flow.connect(CAM, "ingest", self.d1)
        self.assertEqual(sorted(dedup_box.frames(CAM, self.d1)), sorted(self.frames))
        self.assertEqual(self.node(self.d1)["flow"]["frames"], 6)

    def test_a_box_behind_a_classifier_dot_sees_only_classified_frames_of_that_dot(self) -> None:
        flow.update_node(CAM, self.d1, {"source": {"feature": "type", "dot": "all"}})
        flow.update_node(CAM, self.d2, {"source": {"feature": "type", "dot": "B"}})
        self.assertEqual(sorted(dedup_box.frames(CAM, self.d1)), sorted(self.frames[:4]))  # no unlabeled picture
        self.assertEqual(sorted(dedup_box.frames(CAM, self.d2)), sorted(self.frames[2:4]))

    def test_picture_actions_go_through_the_feature_the_state_names(self) -> None:
        flow.update_node(CAM, self.d1, {"source": {"feature": "type", "dot": "all"}})
        for box, feature in ((self.d1, "type"), (self.d2, "whole-frame")):  # a box with no Classifier acts through the whole-frame feature
            state = self.client.get(f"{self.base}/dedup/state", params={"feature": box}).json()
            self.assertEqual(state["source"], feature)
            r = self.client.post(f"{self.base}/classify/delete-preview", json={"feature": state["source"], "frames": self.frames[:1]})
            self.assertEqual(r.status_code, 200)
        r = self.client.post(f"{self.base}/classify/delete-bulk", json={"feature": "whole-frame", "frames": self.frames[4:5], "note": "", "via": "Scatter"})
        self.assertEqual(r.status_code, 200)

    def test_the_grid_endpoint_lists_the_pictures_the_muted_ones_and_the_labels(self) -> None:
        flow.update_node(CAM, self.d1, {"source": {"feature": "type", "dot": "all"}})
        self.mute(self.d1, self.frames[:1])
        r = self.client.get(f"{self.base}/dedup/frames", params={"feature": self.d1})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(sorted(body["frames"]), sorted(self.frames[:4]))
        self.assertEqual(body["muted"], self.frames[:1])
        self.assertEqual(body["source"], "type")
        self.assertEqual(body["marks"][self.frames[0]]["label"], "A")
        self.assertEqual(self.client.get(f"{self.base}/dedup/frames", params={"feature": "seal"}).status_code, 404)

    def test_the_source_line_is_drawn_from_the_dot_and_replaced_by_a_line_from_ingest(self) -> None:
        flow.update_node(CAM, self.d1, {"source": {"feature": "type", "dot": "A"}})
        self.assertIn(("roi:type", "p:A", self.d1), self.edges())
        flow.update_node(CAM, self.d2, {"source": {"feature": "type", "dot": "all"}})
        self.assertIn(("roi:type", "all", self.d2), self.edges())
        flow.connect(CAM, "ingest", self.d1)  # one input: the line from Ingest replaces the dot
        self.assertNotIn(("roi:type", "p:A", self.d1), self.edges())
        self.assertIn(("ingest", None, self.d1), self.edges())
        self.assertIsNone(dedup_box.source_of(CAM, self.d1))

    def test_a_bad_source_is_refused(self) -> None:
        for bad in ({"feature": "nope", "dot": "all"}, {"feature": "type", "dot": "Z"}, "type"):
            with self.assertRaises(flow.FlowError):
                flow.update_node(CAM, self.d1, {"source": bad})

    def test_two_boxes_hold_different_mutes(self) -> None:
        self.mute(self.d1, self.frames[:2])
        self.mute(self.d2, self.frames[4:5])
        self.assertEqual(db.muted_frames(CAM, self.d1), set(self.frames[:2]))
        self.assertEqual(db.muted_frames(CAM, self.d2), {self.frames[4]})
        self.assertEqual(self.node(self.d1)["flow"]["muted"], 2)

    def test_a_classifier_behind_a_box_loses_its_muted_frames_and_only_those(self) -> None:
        self.mute(self.d1, [self.frames[0]])
        dedup_box.set_input(CAM, "seal", self.d1)
        self.assertEqual(db.muted_frames(CAM, "seal"), {self.frames[0]})
        self.assertEqual(db.muted_frames(CAM, "type"), set())  # another Classifier is not behind the box
        self.assertIn((self.d1, None, "roi:seal"), self.edges())
        self.assertNotIn(("ingest", None, "roi:seal"), self.edges())  # it hangs from the box instead
        self.assertEqual(self.node("roi:seal")["frames"], 6)
        dedup_box.set_input(CAM, "seal", None)
        self.assertEqual(db.muted_frames(CAM, "seal"), set())
        self.assertIn(("ingest", None, "roi:seal"), self.edges())

    def test_the_dot_of_a_classifier_behind_a_box_does_not_pass_muted_frames(self) -> None:
        self.mute(self.d1, [self.frames[0]])
        dedup_box.set_input(CAM, "type", self.d1)
        self.assertEqual(sorted(lines.frames_on_dot(CAM, "type", "A")), [self.frames[1]])
        self.assertEqual(sorted(lines.frames_on_dot(CAM, "type", lines.ALL_DOT)), sorted(self.frames[1:4]))

    def test_unmuting_a_picture_in_the_classifier_unmutes_it_in_the_box(self) -> None:
        self.mute(self.d1, self.frames[:2])
        dedup_box.set_input(CAM, "seal", self.d1)
        db.unmute_frames(CAM, "seal", [self.frames[0]])
        self.assertEqual(db.muted_frames(CAM, self.d1), {self.frames[1]})

    def test_a_box_cannot_feed_the_classifier_it_reads_and_the_other_way_round(self) -> None:
        flow.update_node(CAM, self.d1, {"source": {"feature": "type", "dot": "all"}})
        with self.assertRaises(dedup_box.DedupBoxError):
            dedup_box.set_input(CAM, "type", self.d1)
        dedup_box.set_input(CAM, "seal", self.d2)
        with self.assertRaises(flow.FlowError):
            flow.update_node(CAM, self.d2, {"source": {"feature": "seal", "dot": "all"}})

    def test_only_a_dedup_box_can_feed_a_classifier(self) -> None:
        det = flow.create_node(CAM, "detector")
        with self.assertRaises(dedup_box.DedupBoxError):
            dedup_box.set_input(CAM, "seal", det)
        with self.assertRaises(dedup_box.DedupBoxError):
            dedup_box.set_input(CAM, "nope", self.d1)

    def test_line_types_and_reasons(self) -> None:
        graph = flow.load_graph(CAM)
        self.assertIsNone(flow.edge_allowed(graph, "ingest", self.d1))
        crop = flow.create_node(CAM, "crop")
        graph = flow.load_graph(CAM)
        self.assertIsNone(flow.edge_allowed(graph, crop, self.d1))
        self.assertIsNone(flow.edge_allowed(graph, self.d1, crop))  # a Dedup box feeds Picture edits (v1.107.0)
        calc = flow.create_node(CAM, "calc")
        self.assertIn("Calculate takes", flow.edge_allowed(flow.load_graph(CAM), self.d1, calc) or "")
        det = flow.create_node(CAM, "detector")
        self.assertIsNone(flow.edge_allowed(flow.load_graph(CAM), det, self.d1))  # a detector target feeds it (v1.99.0)
        with self.assertRaises(flow.FlowError):
            flow.connect(CAM, det, self.d1)  # not the whole detector: one target's dot

    def test_a_detector_behind_a_dedup_box_works_on_the_pictures_the_box_did_not_mute(self) -> None:
        det = flow.create_node(CAM, "detector")
        self.assertIsNone(flow.edge_allowed(flow.load_graph(CAM), self.d1, det))
        flow.connect(CAM, "ingest", self.d1)
        flow.connect(CAM, self.d1, det)
        self.assertEqual(sorted(flow.node_frames(CAM, det)), sorted(self.frames))
        self.mute(self.d1, self.frames[:2])
        self.assertEqual(sorted(flow.node_frames(CAM, det)), sorted(self.frames[2:]))
        self.mute(self.d2, self.frames[3:4])  # another box's mutes do not count
        self.assertEqual(sorted(flow.node_frames(CAM, det)), sorted(self.frames[2:]))
        flow.update_node(CAM, self.d1, {"source": {"feature": "type", "dot": "all"}})  # the box reads classified pictures only
        self.assertEqual(sorted(flow.node_frames(CAM, det)), sorted(self.frames[2:4]))
        self.assertIn((self.d1, None, det), self.edges())
        flow.disconnect(CAM, self.d1, det)
        self.assertEqual(flow.node_frames(CAM, det), [])  # no line: no pictures

    def test_a_detector_behind_a_dedup_box_keeps_the_picture_edits_above_the_box(self) -> None:
        crop = flow.create_node(CAM, "crop")
        det = flow.create_node(CAM, "detector")
        flow.connect(CAM, crop, self.d1)
        flow.connect(CAM, self.d1, det)
        self.assertEqual(flow.parent_of(flow.load_graph(CAM), det), crop)
        flow.connect(CAM, "ingest", self.d1)
        self.assertEqual(flow.parent_of(flow.load_graph(CAM), det), "ingest")

    def test_a_dedup_box_reading_a_detector_cannot_feed_that_detector_back(self) -> None:
        det = flow.create_node(CAM, "detector")
        graph = flow.load_graph(CAM)
        graph["nodes"][det]["targets"] = [{"name": "P", "examples": []}]
        flow.save_graph(CAM, graph)
        flow.connect(CAM, det, self.d1, point="P")
        self.assertIn("loop", flow.edge_allowed(flow.load_graph(CAM), self.d1, det) or "")

    def test_a_dedup_box_fed_by_a_detector_target_reads_exactly_the_found_box(self) -> None:
        import anchor
        det = flow.create_node(CAM, "detector")
        graph = flow.load_graph(CAM)
        graph["nodes"][det]["targets"] = [{"name": "P", "examples": []}]
        flow.save_graph(CAM, graph)
        flow.connect(CAM, det, self.d1, point="P")
        spec = anchor.get_anchor(CAM, self.d1)
        self.assertEqual((spec["detector"], spec["target"], spec["mode"]), (det, "P", "box"))
        self.assertNotIn("margin", spec)  # no margin at all

    def test_one_dedup_box_feeds_three_picture_edits_boxes_each_feeding_its_own_dedup_box(self) -> None:
        flow.connect(CAM, "ingest", self.d1)
        crops = [flow.create_node(CAM, "crop") for _ in range(3)]
        for crop in crops:
            flow.connect(CAM, self.d1, crop)
        self.assertEqual({(e["source"], e["target"]) for e in flow.load_graph(CAM)["edges"] if e["source"] == self.d1}, {(self.d1, c) for c in crops})
        self.mute(self.d1, self.frames[:2])
        for crop in crops:  # each crop sees what the first box kept, and its picture is the one the box reads
            self.assertEqual(sorted(flow.node_frames(CAM, crop)), sorted(self.frames[2:]))
            self.assertEqual(flow.parent_of(flow.load_graph(CAM), crop), "ingest")
        flow.connect(CAM, crops[0], self.d2)  # Dedup 2 behind the first crop: the survivors of Dedup 1 only
        self.assertEqual(sorted(dedup_box.frames(CAM, self.d2)), sorted(self.frames[2:]))
        self.assertEqual(roi_input.get_input(CAM, self.d2), {"box": crops[0]})
        dedup_box.set_input(CAM, "seal", self.d2)
        self.assertIn((self.d2, None, "roi:seal"), self.edges())
        self.assertIn((self.d1, None, crops[2]), self.edges())
        self.assertIn("loop", flow.edge_allowed(flow.load_graph(CAM), self.d2, crops[0]) or "")

    def test_a_box_page_lists_only_the_pictures_its_input_passes_on(self) -> None:
        crop = flow.create_node(CAM, "crop")
        base = f"{self.base}/flow/nodes/{crop}/frames"
        body = self.client.get(base).json()
        self.assertEqual((body["frames"], body["has_input"]), ([], False))
        flow.connect(CAM, "ingest", self.d1)
        flow.connect(CAM, self.d1, crop)
        self.mute(self.d1, self.frames[:1])
        body = self.client.get(base).json()
        self.assertEqual((sorted(body["frames"]), body["has_input"]), (sorted(self.frames[1:]), True))

    def test_a_picture_edits_box_in_front_is_the_input_of_the_embeddings(self) -> None:
        crop = flow.create_node(CAM, "crop")
        flow.connect(CAM, crop, self.d1)
        self.assertEqual(roi_input.get_input(CAM, self.d1), {"box": crop})
        self.assertIsNone(roi_input.get_input(CAM, self.d2))
        flow.connect(CAM, "ingest", self.d1)
        self.assertIsNone(roi_input.get_input(CAM, self.d1))

    def test_deleting_a_box_forgets_its_mutes_clusters_settings_and_the_classifier_input(self) -> None:
        self.mute(self.d1, self.frames[:2])
        self.mute(self.d2, self.frames[2:3])
        db.set_setting(CAM, f"dedup.epsilon.{self.d1}", "0.05")
        db.save_cluster_snapshot(CAM, self.d1, b"{}")
        dedup_box.set_input(CAM, "seal", self.d1)
        r = self.client.delete(f"{self.base}/flow/nodes/{self.d1}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(db.muted_frames(CAM, self.d1), set())
        self.assertEqual(db.muted_frames(CAM, self.d2), {self.frames[2]})  # the other box keeps its own
        self.assertIsNone(db.get_setting(CAM, f"dedup.epsilon.{self.d1}"))
        self.assertIsNone(db.load_cluster_snapshot(CAM, self.d1))
        self.assertIsNone(dedup_box.input_of(CAM, "seal"))
        self.assertEqual(db.muted_frames(CAM, "seal"), set())

    def test_the_delete_preview_counts_the_mutes(self) -> None:
        self.mute(self.d1, self.frames[:3])
        pv = self.client.get(f"{self.base}/flow/nodes/{self.d1}/delete-preview").json()
        self.assertEqual((pv["kind"], pv["mutes"]), ("dedup", 3))

    def test_the_chain_endpoint_sets_and_clears_the_classifier_input(self) -> None:
        r = self.client.put(f"{self.base}/chain/seal/dedup", json={"box": self.d1})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(next(n for n in r.json()["nodes"] if n["id"] == self.d1)["flow"]["feeds"], ["seal"])
        self.assertEqual(self.client.put(f"{self.base}/chain/seal/dedup", json={"box": "crop:1"}).status_code, 422)
        self.assertEqual(self.client.put(f"{self.base}/chain/seal/dedup", json={"box": None}).status_code, 200)
        self.assertIsNone(dedup_box.input_of(CAM, "seal"))

    def test_the_box_list_for_the_page(self) -> None:
        self.client.put(f"{self.base}/chain/layout", json={"nodes": {self.d2: {"x": 1, "y": 2, "label": "Whole set"}}})
        boxes = self.client.get(f"{self.base}/dedup/boxes").json()
        self.assertEqual(boxes, [{"feature": self.d1, "label": "Dedup 1"}, {"feature": self.d2, "label": "Whole set"}])

    def test_a_feature_classifier_offers_only_the_pictures_of_its_products_as_drawing_background(self) -> None:
        datamodel.save_rois(CAM, datamodel.load_rois(CAM) + [ROI("edge", 0, 0, 1, 1, products=["B"])])
        r = self.client.get(f"{self.base}/frames", params={"feature": "edge"}).json()
        self.assertEqual(sorted(r["frames"]), sorted(self.frames[2:4]))  # the two pictures sorted as B
        self.assertFalse(r["showing_all"])
        self.assertEqual(len(self.client.get(f"{self.base}/frames", params={"feature": "seal"}).json()["frames"]), 6)  # no products: all
        self.assertEqual(self.client.get(f"{self.base}/frames", params={"feature": "nope"}).status_code, 404)

    def test_dedup_pages_know_boxes_and_the_classify_page_names_its_classifier(self) -> None:
        self.assertEqual(self.client.get(f"{self.base}/dedup/state", params={"feature": "nothing"}).status_code, 404)
        self.assertEqual(self.client.get(f"{self.base}/dedup/state", params={"feature": "dedup:99"}).status_code, 404)
        state = self.client.get(f"{self.base}/dedup/state", params={"feature": "type"})  # Classify's Scatter / Outliers views
        self.assertEqual(state.status_code, 200)
        self.assertEqual(state.json()["source"], "type")
        self.assertEqual(self.client.get(f"{self.base}/dedup/state", params={"feature": self.d1}).status_code, 200)

    def test_the_old_per_roi_dedup_data_is_wiped_by_the_migration(self) -> None:
        import sqlite3

        db.add_dedup_mutes(CAM, "seal", [(self.frames[0], "", 1)])
        db.set_setting(CAM, "dedup.epsilon.seal", "0.1")
        db.set_setting(CAM, "other.setting", "keep")
        con = db.connect()
        try:
            con.execute("PRAGMA user_version = 8")
            con.commit()
        finally:
            con.close()
        con = sqlite3.connect(str(db.db_path()))
        con.row_factory = sqlite3.Row
        try:
            db._migrate_v8_to_v9(con)
        finally:
            con.close()
        self.assertEqual(db.muted_frames(CAM, "seal"), set())
        self.assertIsNone(db.get_setting(CAM, "dedup.epsilon.seal"))
        self.assertEqual(db.get_setting(CAM, "other.setting"), "keep")
        self.assertEqual(labels.current_labels(CAM, "type")[self.frames[0]], "A")  # labels are not touched
