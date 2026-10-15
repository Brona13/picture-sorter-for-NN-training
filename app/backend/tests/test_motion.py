from __future__ import annotations

import unittest

import cv2
import numpy as np

import motion

W, H = 320, 240


def texture(seed: int = 1) -> np.ndarray:
    """A grey image with plenty of structure (blobs on smooth noise), so alignment is well defined."""
    rng = np.random.default_rng(seed)
    base = cv2.GaussianBlur(rng.normal(128, 60, (H, W)).astype(np.float32), (0, 0), 4)
    for _ in range(25):
        cv2.circle(base, (int(rng.integers(20, W - 20)), int(rng.integers(20, H - 20))), int(rng.integers(6, 18)), float(rng.integers(30, 230)), -1)
    return cv2.GaussianBlur(base, (0, 0), 1.5)


def move(img: np.ndarray, dx: float = 0.0, dy: float = 0.0, deg: float = 0.0) -> np.ndarray:
    """Shift right/down by (dx, dy) pixels and rotate ``deg`` degrees counter-clockwise on screen."""
    m = cv2.getRotationMatrix2D((W / 2, H / 2), deg, 1.0)
    m[0, 2] += dx
    m[1, 2] += dy
    return cv2.warpAffine(img, m, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def bgr(gray: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(np.clip(gray, 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)


class ShiftAndRotationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = texture()
        self.ref = motion._work_gray(bgr(self.base))

    def shift(self, **kw):
        return motion.template_shift(self.ref, motion._work_gray(bgr(move(self.base, **kw))), (W, H))

    def test_template_shift_recovers_known_shifts(self) -> None:
        for dx, dy in [(5, 0), (0, -7), (-3.5, 4.2), (0, 0)]:
            sx, sy = self.shift(dx=dx, dy=dy)
            self.assertAlmostEqual(sx, dx, delta=0.6, msg=(dx, dy))
            self.assertAlmostEqual(sy, dy, delta=0.6, msg=(dx, dy))

    def test_shift_is_reported_in_full_size_pixels_even_when_the_working_image_is_smaller(self) -> None:
        big = cv2.resize(self.base, (W * 2, H * 2))
        ref = motion._work_gray(bgr(big))
        moved = motion._work_gray(bgr(np.roll(big, 20, axis=1)))  # 20 px at full size
        sx, sy = motion.template_shift(ref, moved, (W * 2, H * 2))
        self.assertAlmostEqual(sx, 20, delta=1.5)
        self.assertAlmostEqual(sy, 0, delta=1.0)

    def test_rotation_sign_is_counter_clockwise_on_screen(self) -> None:
        for deg in (3.0, -4.0, 0.0):
            r = motion.rotation_deg(self.ref, motion._work_gray(bgr(move(self.base, dx=2, dy=-3, deg=deg))))
            self.assertAlmostEqual(r, deg, delta=0.4, msg=deg)

    def test_a_shifted_and_rotated_frame_is_measured_exactly(self) -> None:
        crop = bgr(move(self.base, dx=6, dy=-4, deg=3.0))
        plain = motion.measure_frame(crop, self.ref, box=None, ref_centre=None, source="auto", rotation=False)
        self.assertAlmostEqual(plain[0], 6, delta=0.3)  # the shift is exact even though the frame is rotated
        self.assertAlmostEqual(plain[1], -4, delta=0.3)
        self.assertIsNone(plain[2])  # ... and the rotation is not reported unless asked for
        dx, dy, rot, used = motion.measure_frame(crop, self.ref, box=None, ref_centre=None, source="auto", rotation=True)
        self.assertEqual(used, "template")
        self.assertAlmostEqual(dx, 6, delta=0.3)
        self.assertAlmostEqual(dy, -4, delta=0.3)
        self.assertAlmostEqual(rot, 3.0, delta=0.3)

    def test_a_large_shift_with_a_rotation_still_aligns(self) -> None:
        crop = bgr(move(self.base, dx=40, dy=-30, deg=4.0))
        dx, dy, rot, _ = motion.measure_frame(crop, self.ref, box=None, ref_centre=None, source="auto", rotation=True)
        self.assertAlmostEqual(dx, 40, delta=0.5)
        self.assertAlmostEqual(dy, -30, delta=0.5)
        self.assertAlmostEqual(rot, 4.0, delta=0.4)

    def test_a_detector_box_keeps_its_shift_but_the_rotation_still_comes_from_the_images(self) -> None:
        crop = bgr(move(self.base, dx=6, dy=-4, deg=-2.0))
        box = {"x": 0.45, "y": 0.45, "w": 0.2, "h": 0.2}
        dx, dy, rot, used = motion.measure_frame(crop, self.ref, box=box, ref_centre=(0.5, 0.5), source="auto", rotation=True)
        self.assertEqual(used, "detector")
        self.assertAlmostEqual(dx, 0.05 * W)  # box-based, untouched by ECC
        self.assertAlmostEqual(rot, -2.0, delta=0.4)

    def test_unrelated_textures_are_never_accepted(self) -> None:
        for seed in range(100, 112):
            other = motion._work_gray(bgr(texture(seed=seed)))
            self.assertIsNone(motion.template_shift(self.ref, other, (W, H)), seed)

    def test_the_shared_reference_is_not_modified_by_measuring(self) -> None:
        # cv2.phaseCorrelate windows its inputs in place; a reference reused for every frame must survive that.
        before = self.ref.copy()
        moved = motion._work_gray(bgr(move(self.base, dx=5, deg=2)))
        first = motion.template_shift(self.ref, moved, (W, H))
        for _ in range(5):
            motion.template_shift(self.ref, moved, (W, H))
            motion.rotation_deg(self.ref, moved)
        self.assertTrue(np.array_equal(self.ref, before))
        self.assertEqual(motion.template_shift(self.ref, moved, (W, H)), first)

    def test_unrelated_images_are_not_trusted(self) -> None:
        other = motion._work_gray(bgr(texture(seed=99)))
        self.assertIsNone(motion.template_shift(self.ref, other, (W, H)))
        self.assertIsNone(motion.rotation_deg(self.ref, other))

    def test_size_mismatch_is_not_measured(self) -> None:
        small = motion._work_gray(bgr(cv2.resize(self.base, (100, 80))))
        self.assertIsNone(motion.template_shift(self.ref, small, (W, H)))
        self.assertIsNone(motion.rotation_deg(self.ref, small))


class MeasureFrameTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = texture()
        self.crop = bgr(move(self.base, dx=6, dy=-4))
        self.ref = motion._work_gray(bgr(self.base))
        self.box = {"x": 0.50, "y": 0.50, "w": 0.2, "h": 0.2}

    def test_detector_box_wins_in_auto_mode_and_is_converted_to_pixels(self) -> None:
        dx, dy, rot, used = motion.measure_frame(self.crop, self.ref, box=self.box, ref_centre=(0.55, 0.65), source="auto", rotation=False)
        self.assertEqual(used, "detector")
        self.assertAlmostEqual(dx, (0.6 - 0.55) * W)
        self.assertAlmostEqual(dy, (0.6 - 0.65) * H)
        self.assertIsNone(rot)

    def test_template_is_the_fallback_without_a_box(self) -> None:
        dx, dy, _, used = motion.measure_frame(self.crop, self.ref, box=None, ref_centre=None, source="auto", rotation=False)
        self.assertEqual(used, "template")
        self.assertAlmostEqual(dx, 6, delta=0.7)
        self.assertAlmostEqual(dy, -4, delta=0.7)

    def test_source_modes_are_respected(self) -> None:
        none = motion.measure_frame(self.crop, self.ref, box=None, ref_centre=None, source="detector", rotation=False)
        self.assertEqual(none, (None, None, None, None))
        forced = motion.measure_frame(self.crop, self.ref, box=self.box, ref_centre=(0.55, 0.65), source="template", rotation=False)
        self.assertEqual(forced[3], "template")

    def test_rotation_is_measured_only_when_asked(self) -> None:
        turned = bgr(move(self.base, deg=2.5))
        _, _, off, _ = motion.measure_frame(turned, self.ref, box=None, ref_centre=None, source="auto", rotation=False)
        _, _, on, _ = motion.measure_frame(turned, self.ref, box=None, ref_centre=None, source="auto", rotation=True)
        self.assertIsNone(off)
        self.assertAlmostEqual(on, 2.5, delta=0.4)


class AnalysisTests(unittest.TestCase):
    RESULTS = {
        "crop": [W, H],
        "reference": "r.png",
        "frames": {
            **{f"h{i}": [float(i), float(-i), 0.1 * i, 1] for i in range(1, 21)},
            "bad": [None, None, None, 0],
            "tmpl": [100.0, 0.0, None, 2],
        },
    }

    def test_percentiles_use_the_central_coverage(self) -> None:
        a = motion.analyse(self.RESULTS, coverage=90.0, include={f"h{i}" for i in range(1, 21)})
        dx = a["dx"]
        self.assertEqual((dx["n"], dx["min"], dx["max"]), (20, 1.0, 20.0))
        self.assertAlmostEqual(dx["suggested"][0], 1.95, places=2)  # 5th percentile
        self.assertAlmostEqual(dx["suggested"][1], 19.05, places=2)  # 95th percentile
        self.assertEqual(sum(dx["hist"]["counts"]), 20)
        self.assertEqual(len(dx["hist"]["edges"]), len(dx["hist"]["counts"]) + 1)
        self.assertLess(a["dy"]["suggested"][1], 0)  # dy was the negated dx

    def test_include_filters_frames_and_unmeasured_ones_are_counted(self) -> None:
        a = motion.analyse(self.RESULTS, coverage=100.0)
        self.assertEqual(a["sources"], {"detector": 20, "template": 1, "none": 1})
        self.assertEqual(a["dx"]["max"], 100.0)
        only = motion.analyse(self.RESULTS, coverage=100.0, include={"h1", "h2"})
        self.assertEqual((only["frames"], only["dx"]["n"]), (2, 2))
        self.assertEqual(only["rot"]["n"], 2)
        self.assertIsNone(motion.analyse(self.RESULTS, coverage=100.0, include={"bad"})["dx"])

    def test_single_value_is_its_own_range(self) -> None:
        a = motion.analyse({"frames": {"a": [3.0, 1.0, None, 1]}}, coverage=95.0)
        self.assertEqual(a["dx"]["suggested"], [3.0, 3.0])
        self.assertIsNone(a["rot"])


class SettingsTests(unittest.TestCase):
    def test_defaults_and_ranges(self) -> None:
        s = motion.clean({"ranges": {"dx": [-5, 6.5], "rot": [-2, 2]}})
        self.assertEqual((s["source"], s["coverage"], s["rotation"], s["label"], s["reference"]), ("auto", 95.0, False, None, None))
        self.assertEqual(s["ranges"], {"dx": [-5.0, 6.5], "dy": None, "rot": [-2.0, 2.0]})
        self.assertIsNone(motion.clean(None))
        self.assertIsNone(motion.clean({}))

    def test_rejects_bad_input(self) -> None:
        for raw in (
            {"source": "magic"},
            {"coverage": 10},
            {"coverage": 101},
            {"ranges": {"dx": [3, -3]}},
            {"ranges": {"dx": [1]}},
            {"ranges": {"dy": ["a", "b"]}},
            {"ranges": {"rot": [float("nan"), 1]}},
            {"reference": 5},
        ):
            with self.assertRaises(motion.SettingsError, msg=raw):
                motion.clean({"source": "auto", **raw})


if __name__ == "__main__":
    unittest.main()
