"""Detector-anchored ROI: where the rectangle lands on each picture (see ``anchor.py``). Temp roots only."""
from __future__ import annotations

import unittest

import anchor

SPEC = {"detector": "det:1", "target": "t", "follow_rotation": False, "angle0": 0.0, "dx": 10.0, "dy": -5.0, "w": 20.0, "h": 10.0}


class RectForTests(unittest.TestCase):
    def test_translates_with_the_box(self) -> None:
        r = anchor.rect_for(SPEC, {"x": 100, "y": 50, "angle": 40.0}, "f", 200, 100)
        self.assertAlmostEqual(r.x * 200, 100 + 10 - 10 + 0.5)  # +0.5: pixel index -> pixel edge
        self.assertAlmostEqual(r.y * 100, 50 - 5 - 5 + 0.5)
        self.assertAlmostEqual(r.w * 200, 20)
        self.assertAlmostEqual(r.h * 100, 10)

    def test_no_box_has_no_rectangle(self) -> None:
        self.assertIsNone(anchor.rect_for(SPEC, None, "f", 200, 100))

    def test_clipped_to_the_picture_and_outside_is_none(self) -> None:
        r = anchor.rect_for(SPEC, {"x": 195, "y": 50, "angle": 0.0}, "f", 200, 100)
        self.assertLessEqual(r.x + r.w, 1.0 + 1e-9)
        self.assertIsNone(anchor.rect_for(SPEC, {"x": 400, "y": 50, "angle": 0.0}, "f", 200, 100))

    def test_follow_rotation_turns_the_offset_counter_clockwise_on_screen(self) -> None:
        spec = {**SPEC, "follow_rotation": True, "dx": 10.0, "dy": 0.0, "w": 4.0, "h": 4.0}
        r = anchor.rect_for(spec, {"x": 50, "y": 50, "angle": 90.0}, "f", 100, 100)
        # a point to the right of the box centre ends up above it when the part turns 90 deg counter-clockwise
        self.assertAlmostEqual((r.x + r.w / 2) * 100, 50.5, places=4)
        self.assertAlmostEqual((r.y + r.h / 2) * 100, 40.5, places=4)

    def test_follow_rotation_uses_the_bounding_box_of_the_turned_rectangle(self) -> None:
        spec = {**SPEC, "follow_rotation": True, "dx": 0.0, "dy": 0.0, "w": 20.0, "h": 10.0}
        r = anchor.rect_for(spec, {"x": 50, "y": 50, "angle": 90.0}, "f", 100, 100)
        self.assertAlmostEqual(r.w * 100, 10, places=4)
        self.assertAlmostEqual(r.h * 100, 20, places=4)


if __name__ == "__main__":
    unittest.main()
