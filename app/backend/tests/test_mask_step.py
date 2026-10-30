"""The mask step of a Picture edits box: a shape that blanks the picture outside it, fixed or placed by a followed detector
target (``flow.py``, ``masking.py``). Temp roots only; the detector's boxes are planted, no detector is run."""
from __future__ import annotations

import cv2
import numpy as np

import datamodel
import flow
import ingest
import labels
import masking
from tests.api_helpers import ApiTestCase

CAM = "camM"
W, H = 100, 60
RECT = {"shape": "rect", "x": 0.4, "y": 0.3, "w": 0.2, "h": 0.4}  # x 40..60, y 18..42 on a 100 x 60 picture
BLANK = masking.BLANK_VALUE
# where the planted detector found target "A" on each picture: (x, y, angle)
FOUND = [(50.0, 30.0, 0.0), (70.0, 35.0, 0.0), (50.0, 30.0, 90.0)]


class MaskPureTests(ApiTestCase):
    def test_a_shape_kept_relative_to_a_point_goes_back_around_that_point(self) -> None:
        rel = masking.relative_shape(RECT, W, H, (50.5, 30.5))
        self.assertEqual(rel["shape"], "polygon")
        img = np.full((H, W, 3), 200, np.uint8)
        out = masking.apply_relative(img, rel, (70.5, 35.5))
        self.assertEqual(int(out[35, 70, 0]), 200)  # the centre of the shape is on the new point
        self.assertEqual(int(out[30, 50, 0]), BLANK)  # where it was drawn is blank now
        self.assertEqual(int(out[5, 5, 0]), BLANK)

    def test_turning_goes_counter_clockwise_on_screen(self) -> None:
        self.assertEqual(tuple(round(v, 6) for v in masking.turn_point(1.0, 0.0, 90.0)), (0.0, -1.0))  # right becomes up (y points down)

    def test_a_relative_circle_is_checked_and_kept(self) -> None:
        rel = masking.relative_shape({"shape": "circle", "cx": 0.5, "cy": 0.5, "r": 0.1}, W, H, (50.5, 30.5))
        self.assertEqual(masking.clean_relative(rel)["shape"], "circle")
        with self.assertRaises(masking.MaskError):
            masking.clean_relative({"shape": "circle", "cx": 0, "cy": 0, "r": 0})
        with self.assertRaises(masking.MaskError):
            masking.clean_relative({"shape": "polygon", "points": [{"x": 0, "y": 0}]})


class MaskStepTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        datamodel.ensure_camera_dirs(CAM)
        self.names = []
        for i in range(len(FOUND)):
            name = f"m_{i}.png"
            img = np.full((H, W, 3), 200, np.uint8)
            img[H - 1, W - 1] = 200 + i  # one pixel apart, so the pictures are not taken for duplicates
            cv2.imwrite(str(datamodel.unsorted_dir(CAM) / name), img)
            self.names.append(name)
        ingest.rebuild_index(CAM)
        self.base = f"/api/cameras/{CAM}/flow"

    # --- helpers ---------------------------------------------------------------------------------
    def node(self, kind: str) -> str:
        r = self.client.post(f"{self.base}/nodes", json={"kind": kind})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def detector(self) -> str:
        det = self.node("detector")
        self.assertEqual(self.client.post(f"{self.base}/nodes/{det}/targets", json={"name": "A"}).status_code, 201)
        hashes = labels.hash_map(CAM)
        flow._store(CAM, det, None, {hashes[n]: {"A": {"x": x, "y": y, "angle": a}} for n, (x, y, a) in zip(self.names, FOUND)})
        return det

    def following_box(self, det: str) -> tuple[str, dict]:
        box = self.node("crop")
        r = self.client.post(f"{self.base}/edges", json={"source": det, "target": box, "point": "A"})
        self.assertEqual(r.status_code, 201, r.text)
        return box, self.detail(box)["steps"][0]

    def detail(self, box: str) -> dict:
        return self.client.get(f"{self.base}/nodes/{box}").json()

    def save(self, box: str, steps: list[dict], status: int = 200):
        r = self.client.put(f"{self.base}/nodes/{box}", json={"steps": steps})
        self.assertEqual(r.status_code, status, r.text)
        return r

    def out(self, box: str, frame: str) -> np.ndarray:
        r = self.client.get(f"{self.base}/nodes/{box}/picture", params={"frame": frame, "stage": "output"})
        self.assertEqual(r.status_code, 200, r.text)
        return cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)

    def mask_step(self, **extra) -> dict:
        return {"op": "mask", "shape": RECT, **extra}

    # --- a fixed mask ----------------------------------------------------------------------------
    def test_a_mask_without_a_line_stays_where_it_was_drawn(self) -> None:
        box = self.node("crop")
        self.save(box, [{"op": "crop", "rect": None}, self.mask_step()])
        for name in self.names:
            img = self.out(box, name)
            self.assertEqual(int(img[30, 50, 0]), 200, name)  # inside the shape
            self.assertEqual(int(img[5, 5, 0]), BLANK, name)  # outside it
            self.assertEqual(int(img[35, 75, 0]), BLANK, name)

    def test_a_mask_with_nothing_drawn_passes_the_picture_on(self) -> None:
        box = self.node("crop")
        self.save(box, [{"op": "mask", "shape": None}])
        self.assertTrue(np.all(self.out(box, self.names[0]) == 200))

    def test_a_mask_is_checked(self) -> None:
        box = self.node("crop")
        self.save(box, [{"op": "mask", "shape": {"shape": "hexagon"}}], 422)
        self.save(box, [{"op": "mask", "shape": {"shape": "rect", "x": 0.5, "y": 0.5, "w": 0.0, "h": 0.2}}], 422)
        self.save(box, [{"op": "mask", "shape": RECT, "rel": {"shape": "circle", "cx": 0, "cy": 0, "r": -1}}], 422)

    def test_a_mask_can_be_switched_off_and_keeps_its_place(self) -> None:
        box = self.node("crop")
        self.save(box, [self.mask_step(enabled=False)])
        self.assertTrue(np.all(self.out(box, self.names[0]) == 200))
        self.assertEqual(self.detail(box)["steps"][0]["op"], "mask")

    # --- a mask placed by a followed target ----------------------------------------------------------
    def test_a_mask_follows_the_target_to_its_place_on_every_picture(self) -> None:
        det = self.detector()
        box, crop = self.following_box(det)
        r = self.save(box, [crop, self.mask_step(anchor={"frame": self.names[0]})])
        stored = next(s for s in self.detail(box)["steps"] if s["op"] == "mask")
        self.assertEqual(stored["rel"]["shape"], "polygon")
        self.assertEqual(stored["ref_angle"], 0.0)
        self.assertEqual(stored["frame"], self.names[0])  # the picture it was drawn on
        first = self.out(box, self.names[0])
        self.assertEqual(int(first[30, 50, 0]), 200)
        self.assertEqual(int(first[5, 5, 0]), BLANK)
        moved = self.out(box, self.names[1])  # the target is 20 right and 5 down: so is the shape
        self.assertEqual(int(moved[35, 70, 0]), 200)
        self.assertEqual(int(moved[47, 62, 0]), 200)
        self.assertEqual(int(moved[30, 50, 0]), BLANK)  # where the shape was on the first picture
        self.assertEqual(int(moved[15, 70, 0]), BLANK)

    def test_a_mask_follows_a_crop_that_comes_before_it(self) -> None:
        det = self.detector()
        box, crop = self.following_box(det)
        # the crop that follows the target is drawn first: a window of 60 x 40 around the target, offset by (-10, -5)
        r = self.client.put(f"{self.base}/nodes/{box}", json={"follow": {"frame": self.names[0], "rect": [10, 5, 60, 40]}})
        self.assertEqual(r.status_code, 200, r.text)
        crop = self.detail(box)["steps"][0]
        r = self.save(box, [crop, self.mask_step(shape={"shape": "rect", "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}, anchor={"frame": self.names[0]})])
        for name, (x, y, _) in zip(self.names[:2], FOUND[:2]):
            img = self.out(box, name)
            self.assertEqual(img.shape[:2], (40, 60), name)
            # the window is centred on the target (offset 0), so the shape sits at the same place in the window on both pictures
            self.assertEqual(int(img[20, 30, 0]), 200, name)
            self.assertEqual(int(img[1, 1, 0]), BLANK, name)

    def test_a_mask_can_turn_with_the_target(self) -> None:
        det = self.detector()
        box, crop = self.following_box(det)
        right = {"shape": "rect", "x": 0.6, "y": 0.4, "w": 0.2, "h": 0.2}  # to the right of the target at (50, 30)
        self.save(box, [crop, self.mask_step(shape=right, turn=True, anchor={"frame": self.names[0]})])
        turned = self.out(box, self.names[2])  # the same place, the target turned 90 degrees counter-clockwise
        self.assertEqual(int(turned[11, 50, 0]), 200)  # the shape is above it now
        self.assertEqual(int(turned[30, 70, 0]), BLANK)  # not to the right any more
        self.save(box, [crop, self.mask_step(shape=right, anchor={"frame": self.names[0]})])  # without turning it stays to the right
        fixed = self.out(box, self.names[2])
        self.assertEqual(int(fixed[30, 70, 0]), 200)
        self.assertEqual(int(fixed[11, 50, 0]), BLANK)

    def test_a_picture_without_the_target_has_no_masked_picture(self) -> None:
        det = self.detector()
        box, crop = self.following_box(det)
        self.save(box, [crop, self.mask_step(anchor={"frame": self.names[0]})])
        flow._store(CAM, det, None, {labels.hash_map(CAM)[self.names[0]]: {"A": {"x": 50.0, "y": 30.0, "angle": 0.0}}})  # nothing on the others
        child = self._child_of(box)
        graph = flow.load_graph(CAM)
        rects = flow.output_rects(graph, box)
        found = flow._found_for(CAM, rects, self.names[1])
        with self.assertRaises(flow.NoCrop):
            flow.apply_rects(np.full((H, W, 3), 200, np.uint8), rects, found)
        self.assertEqual(flow.frames_without_crop(CAM, graph, child), [self.names[1], self.names[2]])  # a detector behind the box skips them

    def _child_of(self, box: str) -> str:
        child = self.node("detector")
        self.assertEqual(self.client.post(f"{self.base}/edges", json={"source": box, "target": child}).status_code, 201)
        return child

    def test_drawing_on_a_picture_where_the_target_was_not_found_is_refused(self) -> None:
        det = self.detector()
        box, crop = self.following_box(det)
        flow._store(CAM, det, None, {labels.hash_map(CAM)[self.names[0]]: {"A": {"x": 50.0, "y": 30.0, "angle": 0.0}}})
        r = self.save(box, [crop, self.mask_step(anchor={"frame": self.names[1]})], 422)
        self.assertIn("has not found", r.json()["detail"])

    def test_changing_the_shape_without_placing_it_again_drops_its_place(self) -> None:
        det = self.detector()
        box, crop = self.following_box(det)
        self.save(box, [crop, self.mask_step(anchor={"frame": self.names[0]})])
        placed = next(s for s in self.detail(box)["steps"] if s["op"] == "mask")
        other = {"shape": "circle", "cx": 0.5, "cy": 0.5, "r": 0.1}
        self.save(box, [crop, {**placed, "shape": other}])
        after = next(s for s in self.detail(box)["steps"] if s["op"] == "mask")
        self.assertNotIn("rel", after)
        self.assertEqual(after["shape"], other)

    def test_removing_the_line_or_changing_the_target_forgets_where_the_mask_was_placed(self) -> None:
        det = self.detector()
        box, crop = self.following_box(det)
        self.save(box, [crop, self.mask_step(anchor={"frame": self.names[0]})])
        self.assertTrue(any(s.get("rel") for s in self.detail(box)["steps"]))
        r = self.client.post(f"{self.base}/edges/remove", json={"source": det, "target": box, "point": "A"})
        self.assertEqual(r.status_code, 200, r.text)
        steps = self.detail(box)["steps"]
        self.assertFalse(any(s.get("rel") for s in steps))
        mask = next(s for s in steps if s["op"] == "mask")
        self.assertEqual(mask["shape"], RECT)  # the shape stays, fixed again
        self.assertEqual(int(self.out(box, self.names[1])[30, 50, 0]), 200)

    def test_a_detector_behind_the_box_goes_stale_when_the_mask_or_the_followed_detector_changes(self) -> None:
        det = self.detector()
        box, crop = self.following_box(det)
        self.save(box, [crop, self.mask_step(anchor={"frame": self.names[0]})])
        child = self._child_of(box)
        graph = flow.load_graph(CAM)
        before = flow.signature(graph, child)
        self.save(box, [crop, self.mask_step(shape={"shape": "rect", "x": 0.3, "y": 0.3, "w": 0.4, "h": 0.4}, anchor={"frame": self.names[0]})])
        self.assertNotEqual(flow.signature(flow.load_graph(CAM), child), before)
        steps = [c for c in flow.input_rects(flow.load_graph(CAM), child) if flow.step_follow(c)]
        self.assertTrue(any(flow.is_mask(c) for c in steps))  # the mask depends on the detector it follows
        sig = flow.signature(flow.load_graph(CAM), child)
        self.client.post(f"{self.base}/nodes/{det}/targets", json={"name": "B"})
        self.assertNotEqual(flow.signature(flow.load_graph(CAM), child), sig)

    def test_a_mask_does_not_move_anything(self) -> None:
        box = self.node("crop")
        self.save(box, [{"op": "crop", "rect": [0.25, 0.25, 0.5, 0.5]}, self.mask_step()])
        child = self._child_of(box)
        rects = flow.input_rects(flow.load_graph(CAM), child)
        self.assertEqual(sum(flow.is_mask(r) for r in rects), 1)
        self.assertEqual(flow.rect_map(rects, W, H).point(0, 0), (25.0, 15.0))
        self.assertEqual(flow.rect_offset(rects, W, H), (25, 15))

    def test_the_chain_summary_lists_the_mask(self) -> None:
        import chain  # noqa: PLC0415

        box = self.node("crop")
        self.save(box, [self.mask_step()])
        nodes = {n["id"]: n for n in chain.get_canvas(CAM)["nodes"]}
        self.assertEqual(nodes[box]["flow"]["steps"][0]["op"], "mask")
        self.assertEqual(nodes[box]["flow"]["steps"][0]["shape"], "rect")

    def test_a_draft_preview_follows_the_target_without_saving(self) -> None:
        import json  # noqa: PLC0415

        det = self.detector()
        box, crop = self.following_box(det)
        draft = [crop, self.mask_step(anchor={"frame": self.names[0]})]
        r = self.client.get(f"{self.base}/nodes/{box}/picture", params={"frame": self.names[1], "stage": "output", "steps": json.dumps(draft)})
        self.assertEqual(r.status_code, 200, r.text)
        img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(int(img[35, 70, 0]), 200)  # the shape sits on the moved target
        self.assertEqual(int(img[30, 50, 0]), BLANK)
        self.assertFalse(any(s["op"] == "mask" for s in self.detail(box)["steps"]))  # nothing was saved
