"""Region of a Classifier: as it comes in (no rectangle), its own rectangle, or one chosen but not drawn yet."""
from __future__ import annotations

import anchor
import classify
import datamodel
import engine
import flow
import region
import roi_input
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camR"


class RegionTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 3)
        datamodel.save_rois(CAM, [ROI("old", 0.2, 0.3, 0.4, 0.5), ROI("new", 0.25, 0.25, 0.5, 0.5)])
        self.url = f"/api/cameras/{CAM}/rois"
        self.client.put(f"{self.url}/new/region", json={"mode": "as_is"})  # what the Chain does for a new Classifier

    def key(self, feature: str) -> str:
        return classify._roi_cache_key(engine.resolve_roi(CAM, feature), CAM, feature)

    def node(self, feature: str) -> dict:
        return next(n for n in self.client.get(f"/api/cameras/{CAM}/chain").json()["nodes"] if n["id"] == f"roi:{feature}")

    def test_a_classifier_made_before_keeps_its_rectangle_and_a_new_one_has_none(self) -> None:
        self.assertEqual(region.get_region(CAM, "old"), "own")
        self.assertEqual(region.get_region(CAM, "new"), "as_is")
        old, new = engine.resolve_roi(CAM, "old"), engine.resolve_roi(CAM, "new")
        self.assertEqual((old.x, old.y, old.w, old.h), (0.2, 0.3, 0.4, 0.5))
        self.assertEqual((new.x, new.y, new.w, new.h), (0.0, 0.0, 1.0, 1.0))  # the stored 0.25 rectangle is not used
        self.assertEqual((self.node("new")["region"], self.node("new")["region_source"]), ("as_is", "ingest"))

    def test_the_stored_rectangle_of_an_as_is_classifier_is_not_in_its_cache_key(self) -> None:
        before = self.key("new")
        self.client.patch(f"{self.url}/new/geometry", json={"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3})
        self.assertEqual(self.key("new"), before)
        self.client.patch(f"{self.url}/old/geometry", json={"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3})  # a legacy one is keyed by it
        self.assertNotEqual(self.key("old"), classify._roi_cache_key(ROI("old", 0.2, 0.3, 0.4, 0.5), CAM, "old"))

    def test_own_rectangle_is_not_offered_for_ingest_but_for_a_picture_edits_box(self) -> None:
        r = self.client.put(f"{self.url}/new/region", json={"mode": "own"})
        self.assertEqual(r.status_code, 422)
        self.assertIn("Ingest gives whole pictures", r.json()["detail"])
        crop = flow.create_node(CAM, "crop")
        roi_input.set_input(CAM, "new", crop)
        r = self.client.put(f"{self.url}/new/region", json={"mode": "own"})
        self.assertEqual(r.json()["region"], "own_pending")
        rect = engine.resolve_roi(CAM, "new")
        self.assertEqual((rect.x, rect.w), (0.0, 1.0))  # starts from the whole picture, nothing drawn
        self.assertIsNone(engine.resolve_roi_for_frame(CAM, "new", "h", 100, 100))  # no region until a rectangle is saved
        self.client.patch(f"{self.url}/new/geometry", json={"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4})
        self.assertEqual(region.get_region(CAM, "new"), "own")
        placed = engine.resolve_roi_for_frame(CAM, "new", "h", 100, 100)
        self.assertEqual((placed.x, placed.y, placed.w, placed.h), (0.1, 0.2, 0.3, 0.4))

    def test_removing_the_picture_edits_box_of_a_pending_classifier_goes_back_to_as_is(self) -> None:
        crop = flow.create_node(CAM, "crop")
        roi_input.set_input(CAM, "new", crop)
        self.client.put(f"{self.url}/new/region", json={"mode": "own"})
        self.client.delete(f"{self.url}/new/input")
        self.assertEqual(region.get_region(CAM, "new"), "as_is")

    def test_an_anchored_classifier_follows_its_anchor_mode_and_has_no_region_setting(self) -> None:
        det = flow.create_node(CAM, "detector")
        graph = flow.load_graph(CAM)
        graph["nodes"][det]["targets"] = [{"name": "P", "examples": []}]
        flow.save_graph(CAM, graph)
        anchor.set_anchor(CAM, "new", det, "P", mode="box", image_size=(100, 100))
        self.assertEqual((region.get_region(CAM, "new"), region.source_kind(CAM, "new")), ("as_is", "detector"))
        self.assertEqual(self.client.put(f"{self.url}/new/region", json={"mode": "own"}).status_code, 422)
        self.assertEqual(engine.resolve_roi(CAM, "new").w, 1.0)  # the stored rectangle is ignored for the key


class RegionAnchorTests(ApiTestCase):
    """A detector-fed Classifier: found box shows the box; my own rectangle starts from the found box and is pending until saved."""

    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 3)
        datamodel.save_rois(CAM, [ROI("new", 0.25, 0.25, 0.5, 0.5)])
        self.url = f"/api/cameras/{CAM}/rois"
        self.client.put(f"{self.url}/new/region", json={"mode": "as_is"})
        self.det = flow.create_node(CAM, "detector")
        graph = flow.load_graph(CAM)
        graph["nodes"][self.det]["targets"] = [{"name": "P", "examples": []}]
        flow.save_graph(CAM, graph)

    def test_switching_to_my_own_rectangle_starts_from_the_found_box_and_is_pending_until_saved(self) -> None:
        import unittest.mock as mock

        box = {"x": 0.3, "y": 0.4, "w": 0.2, "h": 0.1}
        with mock.patch.object(anchor, "found_box", return_value=box), mock.patch.object(anchor, "_entry", return_value={"x": 50, "y": 50, "w": 10, "h": 10, "angle": 0}), \
                mock.patch.object(anchor, "_on_frame", side_effect=lambda e, w, h: e):
            anchor.set_anchor(CAM, "new", self.det, "P", mode="box", image_size=(100, 100))
            self.assertEqual(region.get_region(CAM, "new"), "as_is")
            anchor.set_anchor(CAM, "new", self.det, "P", self.frames[0], mode="rect", image_size=(100, 100))
        rect = datamodel.get_roi(CAM, "new")
        self.assertEqual((rect.x, rect.y, rect.w, rect.h), (0.3, 0.4, 0.2, 0.1))  # not the 0.25 placeholder
        self.assertEqual(region.get_region(CAM, "new"), "own_pending")
        self.assertIsNone(engine.resolve_roi_for_frame(CAM, "new", "h", 100, 100))  # no region until it is saved
        self.client.patch(f"{self.url}/new/geometry", json={"x": 0.31, "y": 0.4, "w": 0.2, "h": 0.1})
        self.assertEqual(region.get_region(CAM, "new"), "own")
