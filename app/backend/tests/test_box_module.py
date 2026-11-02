"""The Box module of step 2 (plan ``plans/two-step-solution.md``, stage 4): one upright rectangle per picture from one or two detector boxes."""
from __future__ import annotations

import math
import unittest

import anchor
import box_module
import datamodel
import flow
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camX"


class GeometryTests(unittest.TestCase):
    """The rectangle from detector boxes on the whole picture (pure geometry; angles counter-clockwise on screen, y down)."""

    MARGINS = {"left": 0.0, "right": 0.0, "up": 0.0, "down": 0.0}

    def box(self, x: float, y: float, w: float = 20, h: float = 10, angle: float = 0.0) -> dict:
        return {"x": x, "y": y, "w": w, "h": h, "angle": angle}

    def test_two_upright_holes_from_the_edge_wrap_both_holes(self) -> None:
        r = box_module.rectangle([self.box(100, 100), self.box(300, 100)], "two", "edge", self.MARGINS)
        self.assertEqual((r["x"], r["y"], r["w"], r["h"]), (200.0, 100.0, 220.0, 10.0))  # 90..310 by 95..105
        self.assertEqual(r["angle"], 0.0)

    def test_margins_are_the_background_beyond_the_hole_edge(self) -> None:
        m = {"left": 5.0, "right": 7.0, "up": 20.0, "down": 30.0}
        r = box_module.rectangle([self.box(100, 100), self.box(300, 100)], "two", "edge", m)
        self.assertEqual((r["x"], r["y"], r["w"], r["h"]), (201.0, 105.0, 232.0, 60.0))  # 85..317 by 75..135

    def test_from_the_centre_the_margins_count_from_the_hole_centres(self) -> None:
        m = {"left": 5.0, "right": 7.0, "up": 20.0, "down": 30.0}
        r = box_module.rectangle([self.box(100, 100), self.box(300, 100)], "two", "centre", m)
        self.assertEqual((r["x"], r["y"], r["w"], r["h"]), (201.0, 105.0, 212.0, 50.0))  # 95..307 by 80..130

    def test_the_part_direction_follows_the_two_holes_and_the_rectangle_is_squared_off(self) -> None:
        # the right hole is 100 px to the right and 100 px higher: the part is turned 45 degrees counter-clockwise
        r = box_module.rectangle([self.box(100, 200, 0, 0), self.box(200, 100, 0, 0)], "two", "centre", {"left": 0.0, "right": 0.0, "up": 10.0, "down": 10.0})
        self.assertAlmostEqual(r["angle"], 45.0, places=2)
        # a 141.4 x 20 rectangle turned 45 degrees: the upright box round it is about 113.1 on a side
        self.assertAlmostEqual(r["w"], (141.42 + 20) / math.sqrt(2), delta=0.1)
        self.assertAlmostEqual(r["h"], r["w"], delta=0.1)
        self.assertEqual((r["x"], r["y"]), (150.0, 150.0))
        self.assertEqual(len(r["corners"]), 4)

    def test_up_and_down_turn_with_the_part(self) -> None:
        # a part turned 180 degrees: the left hole is on the right of the picture, so "up" is the bottom of the picture
        r = box_module.rectangle([self.box(300, 100, 0, 0), self.box(100, 100, 0, 0)], "two", "centre", {"left": 0.0, "right": 0.0, "up": 50.0, "down": 10.0})
        self.assertAlmostEqual(r["angle"] % 360, 180.0, places=2)
        self.assertEqual((r["x"], r["y"]), (200.0, 120.0))  # 50 beyond the holes towards the bottom, 10 towards the top
        self.assertEqual((r["w"], r["h"]), (200.0, 60.0))

    def test_one_box_uses_its_own_angle_and_edges(self) -> None:
        m = {"left": 10.0, "right": 10.0, "up": 5.0, "down": 5.0}
        r = box_module.rectangle([self.box(100, 100, 40, 20)], "one", "edge", m)
        self.assertEqual((r["x"], r["y"], r["w"], r["h"]), (100.0, 100.0, 60.0, 30.0))
        turned = box_module.rectangle([self.box(100, 100, 40, 20, 90.0)], "one", "edge", m)
        self.assertEqual(turned["angle"], 90.0)
        self.assertAlmostEqual(turned["w"], 30.0, places=1)  # turned a quarter: the 60 x 30 rectangle stands on its side
        self.assertAlmostEqual(turned["h"], 60.0, places=1)

    def test_one_box_from_the_centre_ignores_the_box_size(self) -> None:
        r = box_module.rectangle([self.box(100, 100, 400, 400)], "one", "centre", {"left": 10.0, "right": 20.0, "up": 5.0, "down": 15.0})
        self.assertEqual((r["x"], r["y"], r["w"], r["h"]), (105.0, 105.0, 30.0, 20.0))

    def test_a_turned_hole_reaches_further_along_the_part_axis(self) -> None:
        # a 40 x 10 hole turned 90 degrees stands 10 wide and 40 high on the picture
        r = box_module.rectangle([self.box(100, 100, 40, 10, 90.0)], "one", "edge", self.MARGINS)
        self.assertAlmostEqual(r["w"], 10.0, places=1)
        self.assertAlmostEqual(r["h"], 40.0, places=1)

    def test_margins_that_leave_no_rectangle_give_none(self) -> None:
        self.assertIsNone(box_module.rectangle([self.box(100, 100, 10, 10)], "one", "edge", {"left": -20.0, "right": 0.0, "up": 0.0, "down": 0.0}))

    def test_two_holes_on_the_same_spot_use_the_first_holes_angle(self) -> None:
        r = box_module.rectangle([self.box(100, 100, 10, 10, 30.0), self.box(100, 100, 10, 10, 30.0)], "two", "edge", self.MARGINS)
        self.assertEqual(r["angle"], 30.0)


class BoxModuleTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 4)
        datamodel.save_rois(CAM, [ROI("pick", 0.1, 0.1, 0.5, 0.5, classes=["OK", "NG"])])
        self.base = f"/api/cameras/{CAM}"
        self.hmap = labels.hash_map(CAM)
        self.det = flow.create_node(CAM, "detector")
        graph = flow.load_graph(CAM)
        graph["nodes"][self.det]["targets"] = [
            {"name": "left hole", "examples": [{"png": "x"}], "count": 1},
            {"name": "right hole", "examples": [{"png": "x"}], "count": 1},
        ]
        flow.save_graph(CAM, graph)
        # the detector ran: both holes found on the first three pictures, only the left one on the fourth
        stored = {}
        for i, frame in enumerate(self.frames):
            found = {"left hole": {"x": 20.0, "y": 30.0, "w": 10, "h": 6, "angle": 0.0, "score": 1.0}}
            if i < 3:
                found["right hole"] = {"x": 60.0 + i, "y": 30.0, "w": 10, "h": 6, "angle": 0.0, "score": 1.0}
            stored[self.hmap[frame]] = found
        flow._store(CAM, self.det, flow.signature(flow.load_graph(CAM), self.det), stored)
        self.box = flow.create_node(CAM, "box")

    def choose(self, mode: str = "two") -> dict:
        body = {"mode": mode, "holes": [{"detector": self.det, "target": "left hole"}, {"detector": self.det, "target": "right hole"}]}
        r = self.client.put(f"{self.base}/flow/nodes/{self.box}", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_a_new_box_is_step_two_with_no_holes_and_no_rectangles(self) -> None:
        node = flow.load_graph(CAM)["nodes"][self.box]
        self.assertEqual((node["step"], node["mode"], node["holes"], node["measure_from"]), (2, "two", [], "edge"))
        self.assertEqual(flow.load_stored(CAM, self.box)["frames"], {})
        detail = self.client.get(f"{self.base}/flow/nodes/{self.box}").json()
        self.assertEqual((detail["needed"], detail["holes"], detail["frames"]), (2, [], []))
        self.assertEqual([c["label"] for c in detail["candidates"]], ["Detector 1 · left hole", "Detector 1 · right hole"])

    def test_choosing_two_holes_makes_a_rectangle_for_every_picture_where_both_were_found(self) -> None:
        detail = self.choose()
        self.assertEqual(len(detail["frames"]), 3)  # the fourth has no right hole
        stored = flow.load_stored(CAM, self.box)["frames"]
        entry = stored[self.hmap[self.frames[0]]]["box"]
        self.assertEqual((entry["x"], entry["y"], entry["w"], entry["h"], entry["angle"], entry["source"]), (40.0, 30.0, 50.0, 6.0, 0.0, "box"))  # 15..65 by 27..33
        self.assertNotIn(self.hmap[self.frames[3]], stored)

    def test_one_box_mode_uses_the_first_box_only_and_covers_every_picture_it_was_found_on(self) -> None:
        self.choose("one")
        self.client.put(f"{self.base}/flow/nodes/{self.box}", json={"margins": {"left": 2, "right": 2, "up": 2, "down": 2}})
        detail = self.client.get(f"{self.base}/flow/nodes/{self.box}").json()
        self.assertEqual((detail["mode"], detail["needed"], len(detail["frames"])), ("one", 1, 4))
        entry = flow.load_stored(CAM, self.box)["frames"][self.hmap[self.frames[3]]]["box"]
        self.assertEqual((entry["x"], entry["y"], entry["w"], entry["h"]), (20.0, 30.0, 14.0, 10.0))

    def test_the_rectangles_follow_the_settings_and_a_new_detector_run(self) -> None:
        self.choose()
        key = self.hmap[self.frames[0]]
        before = flow.load_stored(CAM, self.box)["frames"][key]["box"]
        self.client.put(f"{self.base}/flow/nodes/{self.box}", json={"measure_from": "centre", "margins": {"left": 10, "right": 10, "up": 10, "down": 10}})
        after = flow.load_stored(CAM, self.box)["frames"][key]["box"]
        self.assertNotEqual((before["w"], before["h"]), (after["w"], after["h"]))
        self.assertEqual((after["w"], after["h"]), (60.0, 20.0))  # centres 20 and 60, 10 beyond each; 30 +- 10
        stored = flow.load_stored(CAM, self.det)
        stored["frames"][key]["right hole"]["x"] = 80.0  # the detector is run again
        flow._store(CAM, self.det, "new-run", stored["frames"])
        self.assertEqual(flow.load_stored(CAM, self.box)["frames"][key]["box"]["w"], 80.0)

    def test_settings_are_checked(self) -> None:
        def put(body: dict):
            return self.client.put(f"{self.base}/flow/nodes/{self.box}", json=body)

        self.assertEqual(put({"mode": "three"}).status_code, 422)
        self.assertEqual(put({"measure_from": "corner"}).status_code, 422)
        self.assertEqual(put({"margins": {"sideways": 3}}).status_code, 422)
        self.assertEqual(put({"margins": {"left": "wide"}}).status_code, 422)
        self.assertEqual(put({"holes": [{"detector": self.det, "target": "nope"}]}).status_code, 422)
        same = {"detector": self.det, "target": "left hole"}
        self.assertEqual(put({"holes": [same, same]}).status_code, 422)
        self.assertEqual(put({"holes": [same, {**same, "target": "right hole"}, same]}).status_code, 422)

    def test_a_detector_of_step_two_cannot_be_chosen_as_a_hole(self) -> None:
        other = flow.create_node(CAM, "detector", 2)
        r = self.client.put(f"{self.base}/flow/nodes/{self.box}", json={"holes": [{"detector": other, "target": "x"}]})
        self.assertEqual(r.status_code, 422)

    def test_the_geometry_of_one_picture_has_the_holes_the_turned_rectangle_and_the_upright_one(self) -> None:
        self.choose()
        g = self.client.get(f"{self.base}/flow/nodes/{self.box}/box-geometry", params={"frame": self.frames[0]}).json()
        self.assertEqual([h["target"] for h in g["holes"]], ["left hole", "right hole"])
        self.assertEqual(g["missing"], [])
        self.assertEqual(g["upright"], {"x": 40.0, "y": 30.0, "w": 50.0, "h": 6.0})
        self.assertEqual(len(g["rect"]["corners"]), 4)
        missing = self.client.get(f"{self.base}/flow/nodes/{self.box}/box-geometry", params={"frame": self.frames[3]}).json()
        self.assertEqual((missing["missing"], missing["rect"]), (["right hole"], None))

    def test_the_canvas_shows_the_box_with_its_choice_and_count(self) -> None:
        self.choose()
        nodes = {n["id"]: n for n in self.client.get(f"{self.base}/chain").json()["nodes"]}
        node = nodes[self.box]
        self.assertEqual((node["kind"], node["step"], node["label"]), ("box", 2, "Box 1"))
        self.assertEqual((node["flow"]["ready"], node["flow"]["found"], node["flow"]["targets"]), (True, 3, ["box"]))
        self.assertEqual(node["flow"]["holes"], ["Detector 1 · left hole", "Detector 1 · right hole"])

    def test_a_classifier_can_be_anchored_to_the_box_and_reads_its_rectangle(self) -> None:
        self.choose()
        anchor.set_anchor(CAM, "pick", self.box, "box")
        spec = anchor.get_anchor(CAM, "pick")
        self.assertEqual((spec["detector"], spec["target"]), (self.box, "box"))
        entry = anchor.entry_for(CAM, spec, self.hmap[self.frames[0]])
        self.assertEqual((entry["x"], entry["y"], entry["w"], entry["h"]), (40.0, 30.0, 50.0, 6.0))
        self.assertIsNone(anchor.entry_for(CAM, spec, self.hmap[self.frames[3]]))  # no rectangle where a hole was not found
        with self.assertRaises(anchor.AnchorError):
            anchor.set_anchor(CAM, "pick", self.box, "left hole")

    def test_deleting_the_box_sends_the_classifier_back_to_its_own_rectangle(self) -> None:
        self.choose()
        anchor.set_anchor(CAM, "pick", self.box, "box")
        self.assertEqual(self.client.delete(f"{self.base}/flow/nodes/{self.box}").status_code, 200)
        self.assertIsNone(anchor.get_anchor(CAM, "pick"))
        self.assertEqual(flow.load_stored(CAM, self.box)["frames"], {})

    def test_the_picture_of_a_box_is_the_whole_picture(self) -> None:
        r = self.client.get(f"{self.base}/flow/nodes/{self.box}/picture", params={"frame": self.frames[0], "size": 64})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/jpeg")
