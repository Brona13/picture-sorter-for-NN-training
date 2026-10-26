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

    def test_without_a_line_a_box_has_no_pictures_and_a_line_from_ingest_gives_the_whole_camera(self) -> None:
        self.assertEqual(flow.node_frames(CAM, self.det), [])
        flow.connect(CAM, "ingest", self.det)
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


class DetectorToDedupTests(ApiTestCase):
    """A detector target's dot feeds a Dedup box: the box is anchored to the box the detector found (v1.99.0)."""

    def setUp(self) -> None:
        super().setUp()
        write_frames(CAM + "2", 3)
        self.cam = CAM + "2"
        self.det = flow.create_node(self.cam, "detector")
        flow.connect(self.cam, "ingest", self.det)  # v1.107.0: a box with no line has no pictures
        self.box = flow.create_node(self.cam, "dedup")

    def test_a_target_dot_feeds_the_box_and_the_line_is_its_anchor(self) -> None:
        import anchor
        flow.add_target(self.cam, self.det, "T")
        flow.connect(self.cam, self.det, self.box, point="T")
        spec = anchor.get_anchor(self.cam, self.box)
        self.assertEqual((spec["detector"], spec["target"], spec["mode"]), (self.det, "T", "box"))

    def test_without_a_target_dot_the_line_is_refused(self) -> None:
        with self.assertRaises(flow.FlowError):
            flow.connect(self.cam, self.det, self.box)

    def test_the_grid_lists_and_cuts_only_the_pictures_where_the_detector_found_the_target(self) -> None:
        import labels as lab
        base = f"/api/cameras/{self.cam}"
        names = [p.name for p in datamodel.list_unsorted(self.cam)]
        flow.add_target(self.cam, self.det, "T")
        flow.connect(self.cam, self.det, self.box, point="T")
        self.assertEqual(self.client.get(f"{base}/dedup/frames", params={"feature": self.box}).json()["frames"], [])  # nothing found yet
        hashes = lab.hash_map(self.cam)
        found = {"x": 10.0, "y": 10.0, "angle": 0.0, "score": 1.0, "w": 8, "h": 8, "source": "auto"}
        flow._store(self.cam, self.det, flow.signature(flow.load_graph(self.cam), self.det), {hashes[names[0]]: {"T": found}, hashes[names[1]]: {"T": found}})
        shown = self.client.get(f"{base}/dedup/frames", params={"feature": self.box}).json()["frames"]
        self.assertEqual(sorted(shown), sorted(names[:2]))
        self.assertEqual(self.client.get(f"{base}/frames/{names[0]}/thumb", params={"feature": self.box}).status_code, 200)
        self.assertEqual(self.client.get(f"{base}/frames/{names[2]}/thumb", params={"feature": self.box}).status_code, 404)
        # the viewer (v1.106.0): the box's rectangle on a picture, and its cutout at full resolution
        rect = self.client.get(f"{base}/rois/{self.box}/rect", params={"frame": names[0]}).json()
        self.assertTrue(rect["anchored"] and rect["box"] and rect["rect"] is not None)
        self.assertIsNone(self.client.get(f"{base}/rois/{self.box}/rect", params={"frame": names[2]}).json()["rect"])
        cut = self.client.get(f"{base}/frames/{names[0]}/cutout", params={"feature": self.box})
        self.assertEqual((cut.status_code, cut.headers["content-type"]), (200, "image/png"))
        self.assertEqual(self.client.get(f"{base}/frames/{names[2]}/cutout", params={"feature": self.box}).status_code, 404)
        self.assertEqual(self.client.get(f"{base}/rois/nope/rect", params={"frame": names[0]}).status_code, 404)

    def test_a_box_with_no_detector_line_has_no_anchor(self) -> None:
        import anchor
        self.assertIsNone(anchor.get_anchor(self.cam, self.box))


class ProductClassifierLineTests(ApiTestCase):
    """The product Classifier has no automatic line from Ingest after it is deleted (v1.99.0)."""

    def setUp(self) -> None:
        super().setUp()
        write_frames(CAM + "3", 3)
        self.cam = CAM + "3"
        datamodel.save_rois(self.cam, [ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"])])
        self.base = f"/api/cameras/{self.cam}"

    def ingest_edges(self) -> list:
        return [e for e in self.client.get(f"{self.base}/chain").json()["edges"] if e["source"] == "ingest"]

    def test_the_line_can_be_deleted_and_drawn_again(self) -> None:
        self.assertEqual(len(self.ingest_edges()), 1)
        self.assertFalse(self.ingest_edges()[0]["locked"])
        self.assertEqual(self.client.put(f"{self.base}/chain/type/detached", json={"detached": True}).status_code, 200)
        self.assertEqual(self.ingest_edges(), [])
        self.assertEqual(self.client.put(f"{self.base}/chain/type/detached", json={"detached": False}).status_code, 200)
        self.assertEqual(len(self.ingest_edges()), 1)
