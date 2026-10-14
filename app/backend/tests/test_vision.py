from __future__ import annotations

import cv2
import numpy as np

import classify
import datamodel
import masking
import preprocess
import vision_settings
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames


class PreprocessTests(ApiTestCase):
    def test_every_filter_keeps_shape_and_dtype_with_defaults(self) -> None:
        rng = np.random.default_rng(0)
        img = rng.integers(0, 255, (40, 50, 3), dtype=np.uint8)
        for name in preprocess.FILTERS:
            out = preprocess.apply(img, name)
            self.assertEqual(out.shape, img.shape, name)
            self.assertEqual(out.dtype, img.dtype, name)

    def test_gaussian_smooths(self) -> None:
        img = np.zeros((20, 20, 3), np.uint8)
        img[10, 10] = 255
        out = preprocess.apply(img, "gaussian", {"sigma": 2.0})
        self.assertLess(int(out[10, 10, 0]), 255)

    def test_validation(self) -> None:
        with self.assertRaises(preprocess.FilterError):
            preprocess.normalize("nope", {})
        with self.assertRaises(preprocess.FilterError):
            preprocess.normalize("gaussian", {"sigma": 999})
        with self.assertRaises(preprocess.FilterError):
            preprocess.normalize("gaussian", {"bogus": 1})
        self.assertEqual(preprocess.normalize("median", None), {"size": 3})


class VisionApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames("camA", 2)
        datamodel.save_rois("camA", [ROI(name="seal", x=0.0, y=0.0, w=0.5, h=0.5)])
        self.url = "/api/cameras/camA/vision/seal"

    def test_catalogue(self) -> None:
        body = self.client.get("/api/vision/filters").json()
        self.assertIn("gaussian", body["filters"])

    def test_default_then_save_roundtrip(self) -> None:
        self.assertEqual(self.client.get(self.url).json(), {"filter": None, "mask": None})
        r = self.client.put(self.url, json={"filter": {"name": "gaussian", "params": {"sigma": 2.5}}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.get(self.url).json()["filter"], {"name": "gaussian", "params": {"sigma": 2.5}})
        self.client.put(self.url, json={"filter": None})
        self.assertEqual(self.client.get(self.url).json(), {"filter": None, "mask": None})

    def test_invalid_settings_rejected(self) -> None:
        r = self.client.put(self.url, json={"filter": {"name": "gaussian", "params": {"sigma": 999}}})
        self.assertEqual(r.status_code, 422)
        r = self.client.put(self.url, json={"filter": {"name": "nope"}})
        self.assertEqual(r.status_code, 422)

    def test_unknown_feature_404(self) -> None:
        self.assertEqual(self.client.get("/api/cameras/camA/vision/ghost").status_code, 404)

    def test_preview_returns_cropped_jpeg_without_saving(self) -> None:
        r = self.client.post(
            f"{self.url}/preview",
            json={"frame": self.frames[0], "filter": {"name": "box", "params": {"size": 3}}},
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/jpeg")
        img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(img.shape[:2], (20, 30))  # 40x60 frame, ROI 0.5 x 0.5
        self.assertEqual(self.client.get(self.url).json(), {"filter": None, "mask": None})

    def test_preview_unknown_frame_404(self) -> None:
        r = self.client.post(f"{self.url}/preview", json={"frame": "nope.png"})
        self.assertEqual(r.status_code, 404)


class CacheKeyTests(ApiTestCase):
    def test_signature_only_when_configured_and_changes_with_settings(self) -> None:
        write_frames("camA", 1)
        datamodel.save_rois("camA", [ROI(name="seal", x=0.0, y=0.0, w=0.5, h=0.5)])
        roi = ROI(name="seal", x=0.0, y=0.0, w=0.5, h=0.5)
        plain = classify._roi_cache_key(roi)
        self.assertEqual(classify._roi_cache_key(roi, "camA", "seal"), plain)
        vision_settings.put("camA", "seal", {"filter": {"name": "gaussian", "params": {"sigma": 1.0}}})
        k1 = classify._roi_cache_key(roi, "camA", "seal")
        vision_settings.put("camA", "seal", {"filter": {"name": "gaussian", "params": {"sigma": 2.0}}})
        k2 = classify._roi_cache_key(roi, "camA", "seal")
        self.assertTrue(k1.startswith(plain + "|"))
        self.assertNotEqual(k1, k2)
        vision_settings.put("camA", "seal", {"filter": None})
        self.assertEqual(classify._roi_cache_key(roi, "camA", "seal"), plain)


RECT = {"shape": "rect", "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}
CIRCLE = {"shape": "circle", "cx": 0.5, "cy": 0.5, "r": 0.25}
POLYGON = {"shape": "polygon", "points": [{"x": 0.1, "y": 0.1}, {"x": 0.9, "y": 0.1}, {"x": 0.5, "y": 0.9}]}


class MaskingTests(ApiTestCase):
    def test_rasterize_each_shape(self) -> None:
        for shape in (RECT, CIRCLE, POLYGON):
            inside = masking.rasterize(shape, 40, 60)
            self.assertEqual(inside.shape, (40, 60))
            self.assertTrue(inside[20, 30] or shape is POLYGON)  # centre
            self.assertFalse(inside[0, 0])
            self.assertTrue(inside.any())

    def test_circle_is_round_in_pixels(self) -> None:
        inside = masking.rasterize(CIRCLE, 40, 80)  # r = 0.25 * width = 20 px
        self.assertTrue(inside[20, 40 + 18])
        self.assertFalse(inside[20, 40 + 22])
        self.assertTrue(inside[20 + 18, 40])
        self.assertFalse(inside[39, 40 + 18])

    def test_apply_blanks_outside_with_dark_grey(self) -> None:
        img = np.full((40, 40, 3), 200, np.uint8)
        out = masking.apply(img, RECT)
        self.assertEqual(out.shape, img.shape)
        self.assertEqual(out[0, 0].tolist(), [masking.BLANK_VALUE] * 3)
        self.assertEqual(out[20, 20].tolist(), [200] * 3)
        self.assertEqual(int(img[0, 0, 0]), 200)  # input untouched

    def test_validation(self) -> None:
        for bad in (None, {"shape": "star"}, {"shape": "rect", "x": 0, "y": 0, "w": 0, "h": 1},
                    {"shape": "circle", "cx": 2, "cy": 0.5, "r": 0.1},
                    {"shape": "polygon", "points": [{"x": 0, "y": 0}]}):
            with self.assertRaises(masking.MaskError):
                masking.normalize(bad)


class MaskSettingsTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames("camA", 2)
        datamodel.save_rois("camA", [ROI(name="seal", x=0.0, y=0.0, w=0.5, h=0.5)])
        self.url = "/api/cameras/camA/vision/seal"

    def test_mask_roundtrip_and_validation(self) -> None:
        r = self.client.put(self.url, json={"mask": {"enabled": True, "shape": CIRCLE}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.get(self.url).json()["mask"], {"enabled": True, "shape": CIRCLE})
        bad = self.client.put(self.url, json={"mask": {"enabled": True, "shape": {"shape": "star"}}})
        self.assertEqual(bad.status_code, 422)

    def test_signature_only_changes_when_mask_enabled(self) -> None:
        self.assertEqual(vision_settings.signature("camA", "seal"), "")
        vision_settings.put("camA", "seal", {"mask": {"enabled": False, "shape": RECT}})
        self.assertEqual(vision_settings.signature("camA", "seal"), "")
        vision_settings.put("camA", "seal", {"mask": {"enabled": True, "shape": RECT}})
        sig_rect = vision_settings.signature("camA", "seal")
        vision_settings.put("camA", "seal", {"mask": {"enabled": True, "shape": CIRCLE}})
        self.assertNotEqual(sig_rect, vision_settings.signature("camA", "seal"))

    def test_filter_only_signature_unchanged_by_mask_support(self) -> None:
        import hashlib, json
        flt = {"name": "gaussian", "params": {"sigma": 2.0}}
        vision_settings.put("camA", "seal", {"filter": flt})
        expected = hashlib.sha1(json.dumps(flt, sort_keys=True).encode()).hexdigest()[:8]
        self.assertEqual(vision_settings.signature("camA", "seal"), expected)

    def test_preview_applies_enabled_mask_only(self) -> None:
        def preview(enabled: bool):
            r = self.client.post(
                f"{self.url}/preview",
                json={"frame": self.frames[0], "mask": {"enabled": enabled, "shape": RECT}},
            )
            self.assertEqual(r.status_code, 200)
            return cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)

        masked, plain = preview(True), preview(False)
        self.assertTrue((masked[0, 0] <= masking.BLANK_VALUE + 3).all())
        self.assertFalse(np.array_equal(masked, plain))
        self.assertEqual(self.client.get(self.url).json()["mask"], None)  # preview doesn't save

    def test_enabled_mask_changes_cache_key(self) -> None:
        roi = ROI(name="seal", x=0.0, y=0.0, w=0.5, h=0.5)
        plain = classify._roi_cache_key(roi, "camA", "seal")
        vision_settings.put("camA", "seal", {"mask": {"enabled": True, "shape": RECT}})
        self.assertNotEqual(classify._roi_cache_key(roi, "camA", "seal"), plain)
