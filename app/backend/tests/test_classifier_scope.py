"""A Classifier dot feeds a detector or a Picture edits box (v1.98.0): the box works only on the pictures on that dot."""
from __future__ import annotations

import datamodel
import flow
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camS"


class ClassifierScopeTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 6)
        datamodel.save_rois(CAM, [ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"])])
        for f, cls in zip(self.frames[:4], ["A", "A", "B", "B"]):  # the last two stay unlabeled
            labels.set_label(CAM, "type", f, cls)
        self.det = flow.create_node(CAM, "detector")
        self.crop = flow.create_node(CAM, "crop")
        self.base = f"/api/cameras/{CAM}"

    def test_without_a_dot_a_box_works_on_the_whole_camera(self) -> None:
        self.assertEqual(sorted(flow.node_frames(CAM, self.det)), sorted(self.frames))

    def test_a_class_dot_gives_its_pictures_and_all_gives_the_classified_ones(self) -> None:
        flow.update_node(CAM, self.det, {"source": {"feature": "type", "dot": "B"}})
        flow.update_node(CAM, self.crop, {"source": {"feature": "type", "dot": "all"}})
        self.assertEqual(sorted(flow.node_frames(CAM, self.det)), sorted(self.frames[2:4]))
        self.assertEqual(sorted(flow.node_frames(CAM, self.crop)), sorted(self.frames[:4]))

    def test_the_line_is_drawn_from_the_dot_and_a_line_from_ingest_replaces_it(self) -> None:
        flow.update_node(CAM, self.det, {"source": {"feature": "type", "dot": "A"}})
        sources = [e for e in self.client.get(f"{self.base}/chain").json()["edges"] if e["target"] == self.det]
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["source"], "roi:type")
        flow.connect(CAM, flow.INGEST_ID, self.det)
        self.assertIsNone(flow.node_source(flow.load_graph(CAM), self.det))
        self.assertEqual(sorted(flow.node_frames(CAM, self.det)), sorted(self.frames))

    def test_a_dot_line_replaces_the_line_into_the_box(self) -> None:
        flow.connect(CAM, flow.INGEST_ID, self.det)
        flow.update_node(CAM, self.det, {"source": {"feature": "type", "dot": "A"}})
        self.assertEqual([e for e in flow.load_graph(CAM)["edges"] if e["target"] == self.det], [])

    def test_a_bad_dot_is_refused_and_deleted_pictures_are_not_offered(self) -> None:
        with self.assertRaises(flow.FlowError):
            flow.update_node(CAM, self.det, {"source": {"feature": "type", "dot": "Z"}})
        flow.update_node(CAM, self.det, {"source": {"feature": "type", "dot": "A"}})
        import db
        db.set_frames_removed(CAM, [self.frames[0]], True)
        self.assertEqual(flow.node_frames(CAM, self.det), [self.frames[1]])

    def test_the_summary_tells_the_dot_and_how_many_pictures_it_gives(self) -> None:
        flow.update_node(CAM, self.det, {"source": {"feature": "type", "dot": "B"}})
        node = next(n for n in self.client.get(f"{self.base}/chain").json()["nodes"] if n["id"] == self.det)
        self.assertEqual(node["flow"]["source"], {"feature": "type", "dot": "B"})
        self.assertEqual(node["flow"]["in_scope"], 2)

    def test_renaming_a_product_keeps_the_line(self) -> None:
        import db
        flow.update_node(CAM, self.det, {"source": {"feature": "type", "dot": "A"}})
        db.rename_products(CAM, "type", {"A": "Alpha"})
        self.assertEqual(flow.node_source(flow.load_graph(CAM), self.det), {"feature": "type", "dot": "Alpha"})
