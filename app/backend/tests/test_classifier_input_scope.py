"""A line into a Classifier hands over exactly the pictures the box on the other end passes on (v1.120.0)."""
from __future__ import annotations

import json

import chain
import datamodel
import dedup_box
import db
import flow
import labels
import roi_input
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camInput"


class ClassifierInputScopeTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 8)
        datamodel.save_rois(CAM, [
            ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"]),
            ROI("seal", 0.2, 0.2, 0.5, 0.5),
        ])
        for f, cls in zip(self.frames, ["A", "A", "A", "B", "B", "B", "B", "B"]):
            labels.set_label(CAM, "type", f, cls)
        self.a = self.frames[:3]
        self.base = f"/api/cameras/{CAM}"

    def seal(self) -> list[str]:
        return datamodel.frames_for_feature(CAM, "seal")

    def detector_on_a(self) -> str:
        det = flow.create_node(CAM, "detector")
        flow.update_node(CAM, det, {"source": {"feature": "type", "dot": "A"}})
        return det

    def test_without_a_line_it_sees_the_whole_camera(self) -> None:
        self.assertEqual(sorted(self.seal()), sorted(self.frames))

    def test_anchored_on_a_detector_fed_by_a_dot_it_sees_the_pictures_on_the_dot(self) -> None:
        det = self.detector_on_a()
        db.set_setting(CAM, "roi.anchor.seal", json.dumps({"detector": det, "target": "t", "mode": "box", "follow_rotation": False}))
        self.assertEqual(self.seal(), self.a)
        node = next(n for n in chain.get_canvas(CAM)["nodes"] if n["id"] == "roi:seal")
        self.assertEqual(node["frames"], 3)

    def test_reading_a_picture_edits_box_fed_by_a_dot_it_sees_the_pictures_on_the_dot(self) -> None:
        crop = flow.create_node(CAM, "crop")
        flow.update_node(CAM, crop, {"source": {"feature": "type", "dot": "B"}})
        roi_input.set_input(CAM, "seal", crop)
        self.assertEqual(self.seal(), self.frames[3:])

    def test_a_picture_edits_box_fed_by_ingest_keeps_the_whole_camera(self) -> None:
        crop = flow.create_node(CAM, "crop")
        flow.connect(CAM, flow.INGEST_ID, crop)
        roi_input.set_input(CAM, "seal", crop)
        self.assertEqual(sorted(self.seal()), sorted(self.frames))

    def test_it_follows_the_chain_through_several_boxes(self) -> None:
        crop = flow.create_node(CAM, "crop")
        flow.update_node(CAM, crop, {"source": {"feature": "type", "dot": "A"}})
        det = flow.create_node(CAM, "detector")
        flow.connect(CAM, crop, det)
        db.set_setting(CAM, "roi.anchor.seal", json.dumps({"detector": det, "target": "t", "mode": "box", "follow_rotation": False}))
        self.assertEqual(self.seal(), self.a)

    def test_the_products_list_still_applies_on_top_of_the_line(self) -> None:
        det = self.detector_on_a()
        db.set_setting(CAM, "roi.anchor.seal", json.dumps({"detector": det, "target": "t", "mode": "box", "follow_rotation": False}))
        rois = datamodel.load_rois(CAM)
        next(r for r in rois if r.name == "seal").products = ["B"]
        datamodel.save_rois(CAM, rois)
        self.assertEqual(self.seal(), [])  # A's pictures, narrowed to B's: nothing in common

    def test_a_dedup_box_input_gives_what_the_box_sees(self) -> None:
        dedup = flow.create_node(CAM, "dedup")
        flow.update_node(CAM, dedup, {"source": {"feature": "type", "dot": "A"}})
        self.assertEqual(self.client.put(f"{self.base}/chain/seal/dedup", json={"box": dedup}).status_code, 200)
        self.assertEqual(self.seal(), self.a)

    def test_several_dedup_boxes_give_the_union_and_a_picture_muted_in_one_still_arrives_through_the_other(self) -> None:
        d1, d2 = flow.create_node(CAM, "dedup"), flow.create_node(CAM, "dedup")
        flow.update_node(CAM, d1, {"source": {"feature": "type", "dot": "A"}})
        flow.update_node(CAM, d2, {"source": {"feature": "type", "dot": "B"}})
        for box in (d1, d2):
            self.assertEqual(self.client.put(f"{self.base}/chain/seal/dedup", json={"box": box}).status_code, 200)
        self.assertEqual(sorted(self.seal()), sorted(self.frames))
        self.assertEqual(dedup_box.inputs_of(CAM, "seal"), [d1, d2])
        edges = {(e["source"], e["target"]) for e in self.client.get(f"{self.base}/chain").json()["edges"]}
        self.assertTrue({(d1, "roi:seal"), (d2, "roi:seal")} <= edges)  # one line from each box
        db.add_dedup_mutes(CAM, d1, [(self.a[0], db.frame_hash_for(CAM, self.a[0]), 1)])  # muted in its own box: gone
        db.add_dedup_mutes(CAM, d2, [(self.a[1], db.frame_hash_for(CAM, self.a[1]), 1)])  # muted in a box that never carried it: still in
        self.assertIn(self.a[0], db.muted_frames(CAM, "seal"))
        self.assertNotIn(self.a[1], db.muted_frames(CAM, "seal"))
        # taking one line away leaves the other; removing the box clears nothing else
        self.assertEqual(self.client.put(f"{self.base}/chain/seal/dedup", json={"box": d1, "remove": True}).status_code, 200)
        self.assertEqual(dedup_box.inputs_of(CAM, "seal"), [d2])
        self.assertEqual(db.get_setting(CAM, f"{db.DEDUP_INPUT_KEY}seal"), d2)  # one box is stored as before
        self.assertEqual(self.client.put(f"{self.base}/chain/seal/dedup", json={"box": None}).status_code, 200)
        self.assertEqual(dedup_box.inputs_of(CAM, "seal"), [])

    def test_deleting_a_dedup_box_leaves_the_other_inputs(self) -> None:
        d1, d2 = flow.create_node(CAM, "dedup"), flow.create_node(CAM, "dedup")
        for box in (d1, d2):
            dedup_box.set_input(CAM, "seal", box)
        dedup_box.drop_box(CAM, d1)
        self.assertEqual(dedup_box.inputs_of(CAM, "seal"), [d2])

    def test_deleted_pictures_stay_in_the_set_like_for_every_other_feature(self) -> None:
        det = self.detector_on_a()
        db.set_setting(CAM, "roi.anchor.seal", json.dumps({"detector": det, "target": "t", "mode": "box", "follow_rotation": False}))
        db.mark_frames_deleted(CAM, [(self.frames[6], db.frame_hash_map(CAM)[self.frames[6]])])
        self.assertEqual(self.seal(), self.a + [self.frames[6]])

    def test_pictures_removed_at_ingest_are_out(self) -> None:
        det = self.detector_on_a()
        db.set_setting(CAM, "roi.anchor.seal", json.dumps({"detector": det, "target": "t", "mode": "box", "follow_rotation": False}))
        db.set_frames_removed(CAM, [self.frames[0]], True)
        self.assertEqual(self.seal(), self.a[1:])

    def test_a_loop_through_its_own_dot_does_not_recurse(self) -> None:
        crop = flow.create_node(CAM, "crop")
        flow.update_node(CAM, crop, {"source": {"feature": "type", "dot": "A"}})
        roi_input.set_input(CAM, "type", crop)  # the product Classifier reads a box fed by its own dot
        self.assertEqual(len(datamodel.frames_for_feature(CAM, "type")), 3)
