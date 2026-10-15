from __future__ import annotations

import math
import unittest

import cv2
import numpy as np

import edge_angle

SIZE = 200


def edge_image(angle_deg: float, *, bright_left: bool = True, noise: float = 0.0, seed: int = 0, offset: float = 0.0) -> np.ndarray:
    """A bright/dark half-plane split by a line at ``angle_deg`` (counter-clockwise on screen)."""
    a = math.radians(angle_deg)
    left = np.array([-math.sin(a), -math.cos(a)])  # left of the direction, image coordinates
    ys, xs = np.mgrid[0:SIZE, 0:SIZE].astype(np.float64)
    side = (xs - SIZE / 2) * left[0] + (ys - SIZE / 2) * left[1] - offset
    hi, lo = (200, 40) if bright_left else (40, 200)
    img = np.where(side > 0, hi, lo).astype(np.float64)
    img = cv2.GaussianBlur(img, (0, 0), 1.2)
    if noise:
        img += np.random.default_rng(seed).normal(0, noise, img.shape)
    gray = np.clip(img, 0, 255).astype(np.uint8)
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


def settings_for(angle_deg: float, *, reverse: bool = False, half_width: float = 0.12, points: int = 10, expected=None, length: float = 120.0) -> dict:
    a = math.radians(angle_deg)
    c = np.array([math.cos(a), -math.sin(a)])
    centre = np.array([SIZE / 2, SIZE / 2])
    p1, p2 = centre - length / 2 * c, centre + length / 2 * c
    if reverse:
        p1, p2 = p2, p1
    s = {
        "p1": {"x": p1[0] / SIZE, "y": p1[1] / SIZE},
        "p2": {"x": p2[0] / SIZE, "y": p2[1] / SIZE},
        "half_width": half_width,
        "points": points,
        "expected": expected,
    }
    return edge_angle.clean(s)


def circ_diff(a: float, b: float) -> float:
    return abs((a - b + 90.0) % 180.0 - 90.0)


class MeasureTests(unittest.TestCase):
    def test_recovers_known_angles(self) -> None:
        for angle in (0, 15, 45, 90, 120, 170):
            m = edge_angle.measure(edge_image(angle), settings_for(angle))
            self.assertEqual(m["status"], "ok", angle)
            self.assertLess(circ_diff(m["angle"], angle), 1.5, (angle, m["angle"]))
            self.assertEqual(m["polarity"], "+", angle)

    def test_polarity_follows_the_picture(self) -> None:
        for angle in (20, 100):
            m = edge_angle.measure(edge_image(angle, bright_left=False), settings_for(angle))
            self.assertEqual(m["polarity"], "-")
            self.assertLess(circ_diff(m["angle"], angle), 1.5)
            self.assertLess(m["contrast"], 0)

    def test_drawing_order_changes_nothing(self) -> None:
        img = edge_image(60)
        a = edge_angle.measure(img, settings_for(60))
        b = edge_angle.measure(img, settings_for(60, reverse=True))
        self.assertEqual((a["polarity"], b["polarity"]), ("+", "+"))
        self.assertLess(circ_diff(a["angle"], b["angle"]), 1.5)

    def test_noise_and_a_slightly_off_line(self) -> None:
        m = edge_angle.measure(edge_image(33, noise=10, seed=4, offset=4), settings_for(33))
        self.assertEqual(m["status"], "ok")
        self.assertLess(circ_diff(m["angle"], 33), 2.5)
        self.assertEqual(m["polarity"], "+")

    def test_drawn_line_off_by_some_degrees_still_finds_the_edge(self) -> None:
        m = edge_angle.measure(edge_image(40), settings_for(50, half_width=0.2))
        self.assertEqual(m["status"], "ok")
        self.assertLess(circ_diff(m["angle"], 40), 3.0)

    def test_flat_image_has_no_edge(self) -> None:
        flat = np.full((SIZE, SIZE, 3), 120, np.uint8)
        m = edge_angle.measure(flat, settings_for(30))
        self.assertEqual((m["status"], m["angle"], m["points"]), ("none", None, []))

    def test_points_setting_limits_the_fit_points(self) -> None:
        m = edge_angle.measure(edge_image(30), settings_for(30, points=5))
        self.assertLessEqual(m["n_points"], 5)
        self.assertGreaterEqual(m["n_points"], 3)
        self.assertEqual(len(m["line"]), 2)
        self.assertEqual((len(m["patch_points"]), len(m["patch_line"])), (m["n_points"], 2))
        self.assertTrue(all(0 <= p["x"] <= 1 and 0 <= p["y"] <= 1 for p in m["patch_points"]))

    def test_perpendicular_edge_is_ignored(self) -> None:
        # A band along a horizontal edge must not lock onto a vertical edge crossing it.
        img = edge_image(0)
        img[:, 150:] = 255
        m = edge_angle.measure(img, settings_for(0, half_width=0.2))
        self.assertEqual(m["status"], "ok")
        self.assertLess(circ_diff(m["angle"], 0), 2.0)

    def test_band_patch_and_corners(self) -> None:
        s = settings_for(0)
        patch = edge_angle.band_patch(edge_image(0), s)
        self.assertEqual(patch.shape, (round(2 * 0.12 * SIZE), 120))
        corners = edge_angle.band_corners((SIZE, SIZE), s)
        self.assertEqual(len(corners), 4)
        self.assertAlmostEqual(corners[0]["x"], corners[3]["x"], places=6)


class VerdictTests(unittest.TestCase):
    OK = {"status": "ok", "angle": 90.0, "polarity": "+"}

    def test_pass_fail_and_undetermined(self) -> None:
        exp = {"angle": 90.0, "tolerance": 5.0, "polarity": "+"}
        self.assertEqual(edge_angle.verdict(self.OK, exp), "pass")
        self.assertEqual(edge_angle.verdict({**self.OK, "angle": 96.0}, exp), "fail")
        self.assertEqual(edge_angle.verdict({**self.OK, "polarity": "-"}, exp), "fail")  # opposite direction
        self.assertEqual(edge_angle.verdict({"status": "none"}, exp), "undetermined")
        self.assertIsNone(edge_angle.verdict(self.OK, None))

    def test_angle_wraps_around_180(self) -> None:
        exp = {"angle": 1.0, "tolerance": 5.0, "polarity": "+"}
        self.assertEqual(edge_angle.verdict({**self.OK, "angle": 179.0}, exp), "pass")
        self.assertEqual(edge_angle.verdict({**self.OK, "angle": 170.0}, exp), "fail")


class SettingsTests(unittest.TestCase):
    base = {"p1": {"x": 0.1, "y": 0.5}, "p2": {"x": 0.9, "y": 0.5}}

    def test_defaults_and_expected(self) -> None:
        s = edge_angle.clean({**self.base, "expected": {"angle": 180, "polarity": "-"}})
        self.assertEqual((s["points"], s["half_width"]), (edge_angle.DEFAULT_POINTS, edge_angle.DEFAULT_HALF_WIDTH))
        self.assertEqual(s["expected"], {"angle": 0.0, "tolerance": edge_angle.DEFAULT_TOLERANCE, "polarity": "-"})  # 180 is the same line as 0

    def test_rejects_bad_input(self) -> None:
        bad = [
            {**self.base, "p2": self.base["p1"]},
            {**self.base, "p2": {"x": 1.5, "y": 0.5}},
            {**self.base, "points": 2},
            {**self.base, "points": 41},
            {**self.base, "half_width": 0.9},
            {**self.base, "expected": {"angle": 10, "polarity": "x"}},
            {**self.base, "expected": {"angle": 190, "polarity": "+"}},
            {**self.base, "expected": {"angle": 10, "polarity": "+", "tolerance": 0}},
            {"p1": {"x": 0.1, "y": 0.5}},
        ]
        for raw in bad:
            with self.assertRaises(edge_angle.SettingsError, msg=raw):
                edge_angle.clean(raw)

    def test_empty_means_no_rule(self) -> None:
        self.assertIsNone(edge_angle.clean(None))
        self.assertIsNone(edge_angle.clean({}))


if __name__ == "__main__":
    unittest.main()
