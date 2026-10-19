from __future__ import annotations

import unittest

import cv2
import numpy as np

import benchmark_rotsearch as bench
import rotsearch


def textured(size: int, seed: int) -> np.ndarray:
    return bench.background(size, np.random.default_rng(seed))


def component(size: int = 240) -> tuple[np.ndarray, tuple[float, float], tuple[float, float]]:
    """Two identical round holes that differ only by what is next to them (a notch on the left one's left side, a
    triangle on the right one's right side), on a textured plate. Returns the picture and the two hole centres."""
    img = textured(size, 5)
    a, b = (size / 2 - 50.0, size / 2), (size / 2 + 50.0, size / 2)
    for cx, cy in (a, b):
        cv2.circle(img, (int(cx), int(cy)), 18, 30, -1)
    cv2.rectangle(img, (int(a[0]) - 34, int(a[1]) - 6), (int(a[0]) - 24, int(a[1]) + 6), 235, -1)
    triangle = np.array([[b[0] + 24, b[1] - 12], [b[0] + 38, b[1]], [b[0] + 24, b[1] + 12]], np.int32)
    cv2.fillPoly(img, [triangle], 235)
    return img, a, b


def turned(img: np.ndarray, angle: float, noise: float = 4.0, seed: int = 1) -> np.ndarray:
    """The picture turned by ``angle`` (counter-clockwise on screen) about its centre, with noise."""
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D(((w - 1) / 2.0, (h - 1) / 2.0), angle, 1.0)
    out = cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    rng = np.random.default_rng(seed)
    return np.clip(out.astype(np.float32) + rng.normal(0, noise, out.shape), 0, 255).astype(np.uint8)


def vector_angle(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Direction from a to b in degrees, 0 = to the right, counter-clockwise as seen on screen, 0..360."""
    return float(np.degrees(np.arctan2(-(b[1] - a[1]), b[0] - a[0])) % 360.0)


def angle_error(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


class FindTests(unittest.TestCase):
    def setUp(self) -> None:
        self.example = bench.pattern(64)

    def planted(self, cx: float, cy: float, angle: float, size: int = 250, seed: int = 2) -> np.ndarray:
        frame = bench.plant(textured(size, seed), self.example, cx, cy, angle)
        rng = np.random.default_rng(seed)
        return np.clip(frame.astype(np.float32) + rng.normal(0, 5, frame.shape), 0, 255).astype(np.uint8)

    def test_finds_position_and_angle_at_many_angles_including_the_wrap(self) -> None:
        for angle in (0.0, 37.3, 90.0, 179.5, 181.0, 270.0, 359.2):
            with self.subTest(angle=angle):
                m = rotsearch.find(self.planted(120.4, 98.7, angle), self.example)
                self.assertIsNotNone(m)
                self.assertLess(float(np.hypot(m.x - 120.4, m.y - 98.7)), 0.5)
                self.assertLess(angle_error(m.angle, angle), 1.5)
                self.assertGreater(m.score, 0.9)
                self.assertTrue(0.0 <= m.angle < 360.0)

    def test_the_centre_is_sub_pixel(self) -> None:
        errors = []
        for i, (cx, cy) in enumerate([(100.25, 90.75), (140.5, 120.1), (80.9, 150.6)]):
            m = rotsearch.find(self.planted(cx, cy, 33.0, seed=10 + i), self.example)
            errors.append(float(np.hypot(m.x - cx, m.y - cy)))
        self.assertLess(max(errors), 0.35)

    def test_angle_range_limits_the_search(self) -> None:
        frame = self.planted(120, 100, 10.0)
        m = rotsearch.find(frame, self.example, angle_range=(-30.0, 30.0))
        self.assertLess(angle_error(m.angle, 10.0), 1.5)
        fixed = rotsearch.find(self.planted(120, 100, 0.0), self.example, angle_range=(0.0, 0.0))
        self.assertLess(angle_error(fixed.angle, 0.0), 0.01)
        self.assertLess(float(np.hypot(fixed.x - 120, fixed.y - 100)), 0.5)

    def test_region_restricts_the_search_and_results_stay_in_picture_coordinates(self) -> None:
        frame = self.planted(180, 150, 60.0)
        inside = rotsearch.find(frame, self.example, region=(120, 90, 250, 210))
        self.assertLess(float(np.hypot(inside.x - 180, inside.y - 150)), 0.5)
        outside = rotsearch.find(frame, self.example, region=(0, 0, 100, 100))
        self.assertLess(outside.score, 0.5)  # the pattern is not there; whatever is found there is a poor match
        self.assertIsNone(rotsearch.find(frame, self.example, region=(300, 300, 400, 400)))

    def test_a_region_smaller_than_the_example_is_still_searched(self) -> None:
        frame = self.planted(120, 100, 0.0)
        m = rotsearch.find(frame, self.example, angle_range=(0.0, 0.0), region=(110, 90, 131, 111))
        self.assertIsNotNone(m)
        self.assertLess(float(np.hypot(m.x - 120, m.y - 100)), 1.0)

    def test_a_flat_example_is_refused(self) -> None:
        self.assertIsNone(rotsearch.find(textured(100, 1), np.full((30, 30), 120, np.uint8)))

    def test_colour_pictures_are_accepted(self) -> None:
        frame = cv2.cvtColor(self.planted(100, 100, 45.0), cv2.COLOR_GRAY2BGR)
        m = rotsearch.find(frame, cv2.cvtColor(self.example, cv2.COLOR_GRAY2BGR))
        self.assertLess(float(np.hypot(m.x - 100, m.y - 100)), 0.5)

    def test_without_masked_correlation_the_search_still_works(self) -> None:
        saved = rotsearch._MASK_SUPPORTED
        rotsearch._MASK_SUPPORTED = False
        try:
            m = rotsearch.find(self.planted(120, 100, 75.0), self.example)
        finally:
            rotsearch._MASK_SUPPORTED = saved
        self.assertLess(float(np.hypot(m.x - 120, m.y - 100)), 1.0)
        self.assertLess(angle_error(m.angle, 75.0), 3.0)

    def test_match_bbox_and_region(self) -> None:
        m = rotsearch.Match(x=100.0, y=50.0, angle=90.0, score=1.0, w=40, h=20)
        x0, y0, x1, y1 = m.bbox()
        self.assertAlmostEqual(x1 - x0, 20.0, places=6)  # turned a quarter: width and height swap
        self.assertAlmostEqual(y1 - y0, 40.0, places=6)
        self.assertEqual(m.region((200, 300), pad=0.0)[0:2], (90, 30))
        x0, y0, x1, y1 = m.region((60, 120), pad=1.0)
        self.assertTrue(0 <= x0 and 0 <= y0 and x1 <= 120 and y1 <= 60)


class TwoHolesTests(unittest.TestCase):
    """The real case: two identical holes told apart by what is next to them; the angle from A to B is the turn."""

    def setUp(self) -> None:
        self.plate, self.a, self.b = component()
        self.left = self.plate[int(self.a[1]) - 28 : int(self.a[1]) + 29, int(self.a[0]) - 40 : int(self.a[0]) + 24].copy()
        self.right = self.plate[int(self.b[1]) - 28 : int(self.b[1]) + 29, int(self.b[0]) - 24 : int(self.b[0]) + 44].copy()
        self.targets = {"left": [self.left], "right": [self.right]}

    def test_left_and_right_are_found_and_the_angle_a_to_b_follows_the_turn(self) -> None:
        for turn in (0.0, 12.0, 175.0, 183.0, 300.0):
            with self.subTest(turn=turn):
                found = rotsearch.find_targets(turned(self.plate, turn), self.targets)
                left, right = found["left"], found["right"]
                self.assertIsNotNone(left)
                self.assertIsNotNone(right)
                # the crops are not centred on the holes, so compare turned positions of the crop centres
                angle = vector_angle((left.x, left.y), (right.x, right.y))
                self.assertLess(angle_error(angle, (0.0 + turn) % 360.0), 1.0)
                self.assertLess(angle_error(left.angle, turn), 1.5)
                self.assertLess(angle_error(right.angle, turn), 1.5)

    def test_identity_is_kept_when_the_component_is_turned_half_way_round(self) -> None:
        found = rotsearch.find_targets(turned(self.plate, 180.0), self.targets)
        # turned by 180 degrees the left example sits on the right side of the picture
        self.assertGreater(found["left"].x, found["right"].x)

    def test_second_detector_finds_the_hole_inside_the_first_ones_box(self) -> None:
        turn = 175.0
        picture = turned(self.plate, turn)
        found = rotsearch.find_targets(picture, self.targets)
        hole = self.plate[int(self.a[1]) - 22 : int(self.a[1]) + 23, int(self.a[0]) - 22 : int(self.a[0]) + 23].copy()
        centres = {}
        for name, match in found.items():
            inner = rotsearch.find(picture, hole, angle_range=(0.0, 0.0), region=match.region(picture.shape, pad=0.3))
            self.assertIsNotNone(inner)
            centres[name] = (inner.x, inner.y)
        angle = vector_angle(centres["left"], centres["right"])
        self.assertLess(angle_error(angle, turn), 1.0)
        # the holes of the turned plate: centres moved by the same turn about the picture centre
        h, w = self.plate.shape[:2]
        m = cv2.getRotationMatrix2D(((w - 1) / 2.0, (h - 1) / 2.0), turn, 1.0)
        for name, (px, py) in (("left", self.a), ("right", self.b)):
            ex, ey = m @ np.array([px, py, 1.0])
            self.assertLess(float(np.hypot(centres[name][0] - ex, centres[name][1] - ey)), 1.0)


if __name__ == "__main__":
    unittest.main()
