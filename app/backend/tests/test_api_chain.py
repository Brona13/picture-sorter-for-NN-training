"""Chain canvas: the map is derived from the ROI definitions; only the layout is stored."""
from __future__ import annotations

import datamodel
import db
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camA"


class ChainApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 4)
        self.base = f"/api/cameras/{CAM}/chain"

    def canvas(self) -> dict:
        r = self.client.get(self.base)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def edges(self) -> set[tuple]:
        return {(e["source"], e["source_handle"], e["target"]) for e in self.canvas()["edges"]}

    def node(self, node_id: str) -> dict:
        return next(n for n in self.canvas()["nodes"] if n["id"] == node_id)

    def make_chain(self) -> None:
        datamodel.save_rois(CAM, [
            ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"]),
            ROI("seal", 0, 0, 0.5, 0.5, products=["A"]),
            ROI("edge", 0, 0, 0.5, 0.5),
            ROI("B::rod", 0, 0, 0.5, 0.5),
        ])

    def test_empty_camera_has_only_ingest_with_frame_count(self) -> None:
        c = self.canvas()
        self.assertEqual([n["id"] for n in c["nodes"]], ["ingest"])
        self.assertEqual(c["nodes"][0]["frames"], 4)
        self.assertEqual(c["edges"], [])

    def test_edges_are_derived_from_the_rois(self) -> None:
        self.make_chain()
        self.assertEqual(self.edges(), {
            ("ingest", None, "roi:type"),
            ("roi:type", "p:A", "roi:seal"),
            ("ingest", None, "roi:edge"),
            ("roi:type", "p:B", "roi:B::rod"),
        })
        locked = {e["target"]: e["locked"] for e in self.canvas()["edges"]}
        self.assertTrue(locked["roi:B::rod"])
        self.assertFalse(locked["roi:seal"])

    def test_there_is_no_classify_box_and_no_line_to_one(self) -> None:
        self.make_chain()
        self.assertFalse([n for n in self.canvas()["nodes"] if n["kind"] == "classify"])
        self.assertFalse([e for e in self.canvas()["edges"] if "classify:" in e["source"] + e["target"]])

    def test_shared_roi_gets_one_edge_per_product(self) -> None:
        datamodel.save_rois(CAM, [
            ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B", "C"]),
            ROI("seal", 0, 0, 0.5, 0.5, products=["A", "B"]),
        ])
        self.assertIn(("roi:type", "p:B", "roi:seal"), self.edges())
        self.assertIn(("roi:type", "p:A", "roi:seal"), self.edges())

    def test_every_product_is_one_line_from_the_all_dot(self) -> None:
        self.make_chain()
        self.client.patch(f"/api/cameras/{CAM}/rois/seal/products", json={"products": ["A", "B"]})
        edges = self.edges()
        self.assertIn(("roi:type", "all", "roi:seal"), edges)
        self.assertNotIn(("roi:type", "p:A", "roi:seal"), edges)

    def test_a_detached_feature_hangs_alone_until_a_line_is_drawn(self) -> None:
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 0.5, 0.5)])
        self.assertEqual(self.edges(), {("ingest", None, "roi:seal")})
        r = self.client.put(f"{self.base}/seal/detached", json={"detached": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.edges(), set())  # no line, and the Classifier still reads the whole camera
        self.assertEqual(self.node("roi:seal")["frames"], 4)
        self.client.patch(f"/api/cameras/{CAM}/rois/seal/products", json={"products": []})  # drawing a line from Ingest
        self.assertEqual(self.edges(), {("ingest", None, "roi:seal")})
        self.assertEqual(self.client.put(f"{self.base}/nope/detached", json={"detached": True}).status_code, 404)

    def test_without_classify_roi_features_hang_from_ingest(self) -> None:
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 1, 1)])
        self.assertEqual(self.edges(), {("ingest", None, "roi:seal")})

    def test_boxes_without_stored_position_are_placed_in_columns(self) -> None:
        self.make_chain()
        nodes = {n["id"]: n for n in self.canvas()["nodes"]}
        self.assertEqual((nodes["ingest"]["x"], nodes["roi:type"]["x"]), (0, 280))
        self.assertEqual(nodes["roi:seal"]["x"], 840)
        ys = sorted(nodes[i]["y"] for i in ("roi:seal", "roi:edge", "roi:B::rod"))
        self.assertEqual(len(set(ys)), 3)

    def test_a_new_box_is_placed_below_the_stored_ones(self) -> None:
        self.make_chain()
        self.client.put(f"{self.base}/layout", json={"nodes": {
            "roi:seal": {"x": 840, "y": 0}, "roi:edge": {"x": 840, "y": 150}, "roi:B::rod": {"x": 840, "y": 300},
        }})
        datamodel.save_rois(CAM, [*datamodel.load_rois(CAM), ROI("extra", 0, 0, 1, 1)])
        self.assertEqual((self.node("roi:extra")["x"], self.node("roi:extra")["y"]), (840, 450))
        self.assertEqual(self.node("roi:seal")["y"], 0)

    def test_the_product_classifier_counts_the_products(self) -> None:
        self.assertNotIn("roi:type", [n["id"] for n in self.canvas()["nodes"]])
        self.make_chain()
        labels.set_label(CAM, "type", self.frames[0], "A")
        labels.set_label(CAM, "type", self.frames[1], "A")
        labels.set_label(CAM, "type", self.frames[2], "B")
        box = self.node("roi:type")
        self.assertEqual((box["kind"], box["ref"], box["mode"]), ("roi", "type", "product"))
        self.assertEqual(box["product_counts"], {"A": 2, "B": 1})
        self.assertEqual((box["labeled"], box["unlabeled"], box["frames"], box["deleted"]), (3, 1, 4, 0))

    def test_a_feature_classifier_counts_its_own_classes_over_its_own_pictures(self) -> None:
        self.make_chain()
        labels.set_label(CAM, "edge", self.frames[0], "OK")
        labels.set_label(CAM, "edge", self.frames[1], "NG")
        labels.set_label(CAM, "edge", self.frames[2], "NG")
        box = self.node("roi:edge")
        self.assertEqual((box["mode"], box["classes"]), ("feature", ["OK", "NG"]))
        self.assertEqual(box["product_counts"], {"OK": 1, "NG": 2})
        self.assertEqual((box["labeled"], box["unlabeled"], box["frames"]), (3, 1, 4))
        self.assertEqual(box["role"], "quality")
        self.assertEqual(self.node("roi:type")["role"], "classify")

    def test_a_product_scoped_feature_classifier_only_counts_that_products_pictures(self) -> None:
        self.make_chain()
        labels.set_label(CAM, "type", self.frames[0], "B")
        labels.set_label(CAM, "type", self.frames[1], "B")
        labels.set_label(CAM, "type", self.frames[2], "A")
        self.assertEqual(self.node("roi:B::rod")["frames"], 2)
        self.assertEqual(self.node("roi:seal")["frames"], 1)  # seal applies to product A
        self.assertEqual(self.node("roi:edge")["frames"], 4)  # whole camera

    def test_the_bin_counts_deleted_pictures(self) -> None:
        self.make_chain()
        db.mark_frames_deleted(CAM, [(self.frames[0], db.frame_hash_for(CAM, self.frames[0]))])
        self.assertEqual(self.node("roi:type")["deleted"], 1)

    def test_the_classifier_keeps_a_stored_name_and_goes_with_its_roi(self) -> None:
        self.make_chain()
        self.client.put(f"{self.base}/layout", json={"nodes": {"roi:type": {"x": 5, "y": 6, "label": "Sort"}}})
        box = self.node("roi:type")
        self.assertEqual((box["x"], box["y"], box["label"]), (5, 6, "Sort"))
        self.client.delete(f"/api/cameras/{CAM}/rois/type")
        self.assertNotIn("roi:type", [n["id"] for n in self.canvas()["nodes"]])

    def test_the_evaluation_is_picked_in_the_panel_or_drawn_and_its_line_shows(self) -> None:
        self.make_chain()
        made = self.client.post(f"/api/cameras/{CAM}/flow/nodes", json={"kind": "evaluation"}).json()["id"]
        r = self.client.put(f"{self.base}/edge/evaluation", json={"box": made})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.node("roi:edge")["evaluation"], made)
        self.assertTrue([e for e in self.canvas()["edges"] if e["source"] == made and e["target"] == "roi:edge"])  # drawn from its "all" dot
        self.assertEqual(self.client.put(f"{self.base}/edge/evaluation", json={"box": None}).status_code, 200)
        self.assertIsNone(self.node("roi:edge")["evaluation"])

    def test_only_an_evaluation_box_can_be_picked_and_deleting_it_clears_the_pick(self) -> None:
        self.make_chain()
        det = self.client.post(f"/api/cameras/{CAM}/flow/nodes", json={"kind": "detector"}).json()["id"]
        self.assertEqual(self.client.put(f"{self.base}/edge/evaluation", json={"box": det}).status_code, 422)
        made = self.client.post(f"/api/cameras/{CAM}/flow/nodes", json={"kind": "evaluation"}).json()["id"]
        self.client.put(f"{self.base}/edge/evaluation", json={"box": made})
        self.client.delete(f"/api/cameras/{CAM}/flow/nodes/{made}")
        self.assertIsNone(self.node("roi:edge")["evaluation"])

    def test_node_status_counts_frames_and_labels(self) -> None:
        self.make_chain()
        self.assertEqual(self.node("roi:type")["frames"], 4)
        self.assertEqual(self.node("roi:type")["classes"], ["A", "B"])
        self.assertEqual(self.node("roi:seal")["scope"], "products")
        self.assertEqual(self.node("roi:B::rod")["scope"], "name")
        self.assertEqual(self.node("roi:edge")["scope"], "camera")
        self.assertEqual(self.node("roi:type")["labeled"], 0)

    def test_layout_round_trips_and_renames_are_cosmetic(self) -> None:
        self.make_chain()
        body = {
            "nodes": {"roi:seal": {"x": 12.5, "y": -3, "label": "  My seal  "}, "ingest": {"x": 1, "y": 2}},
            "viewport": {"x": 5, "y": 6, "zoom": 0.5},
        }
        r = self.client.put(f"{self.base}/layout", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        seal = self.node("roi:seal")
        self.assertEqual((seal["x"], seal["y"], seal["label"], seal["ref"]), (12.5, -3, "My seal", "seal"))
        self.assertEqual(self.canvas()["viewport"], {"x": 5, "y": 6, "zoom": 0.5})
        self.assertIsNotNone(datamodel.get_roi(CAM, "seal"))

    def test_layout_for_a_deleted_roi_is_dropped(self) -> None:
        self.make_chain()
        self.client.put(f"{self.base}/layout", json={"nodes": {"roi:edge": {"x": 9, "y": 9}}})
        self.client.delete(f"/api/cameras/{CAM}/rois/edge")
        self.assertNotIn("roi:edge", [n["id"] for n in self.canvas()["nodes"]])

    def test_bad_layouts_are_rejected(self) -> None:
        bad = [
            {"nodes": {"ingest": {"x": "a", "y": 0}}},
            {"nodes": {"ingest": {"x": 0, "y": 0, "label": "x" * 61}}},
            {"nodes": {}, "viewport": {"x": 0, "y": 0, "zoom": 0}},
        ]
        for body in bad:
            r = self.client.put(f"{self.base}/layout", json=body)
            self.assertEqual(r.status_code, 422, body)

    def test_infinite_coordinates_are_rejected(self) -> None:
        r = self.client.put(
            f"{self.base}/layout",
            content='{"nodes": {"ingest": {"x": Infinity, "y": 0}}}',
            headers={"content-type": "application/json"},
        )
        self.assertEqual(r.status_code, 422)

    def test_corrupt_stored_layout_falls_back_to_empty(self) -> None:
        db.set_setting(CAM, "chain.canvas", "{not json")
        self.assertEqual([n["id"] for n in self.canvas()["nodes"]], ["ingest"])

    def test_delete_preview_counts_what_the_delete_removes(self) -> None:
        self.make_chain()
        labels.set_label(CAM, "seal", self.frames[0], "OK")
        preview = self.client.get(f"{self.base}/delete-preview", params={"feature": "seal"}).json()
        self.assertEqual(preview["counts"]["labels"], 1)
        removed = self.client.delete(f"/api/cameras/{CAM}/rois/seal").json()["removed"]
        self.assertEqual(removed["labels"], preview["counts"]["labels"])

    def test_delete_preview_for_classify_roi_lists_product_scoped_boxes(self) -> None:
        self.make_chain()
        preview = self.client.get(f"{self.base}/delete-preview", params={"feature": "type"}).json()
        self.assertEqual(preview["dependents"], ["B::rod"])

    def test_delete_preview_unknown_roi_is_404(self) -> None:
        r = self.client.get(f"{self.base}/delete-preview", params={"feature": "nope"})
        self.assertEqual(r.status_code, 404)

    def test_unknown_camera_is_404(self) -> None:
        self.assertEqual(self.client.get("/api/cameras/nope/chain").status_code, 404)


if __name__ == "__main__":
    import unittest

    unittest.main()
