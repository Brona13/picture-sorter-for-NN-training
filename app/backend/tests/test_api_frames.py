from __future__ import annotations

import cv2
import numpy as np

import datamodel
import db
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames


class FramesApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames("camA", 3)
        datamodel.save_rois("camA", [ROI(name="seal", x=0.0, y=0.0, w=0.5, h=0.5)])
        self.base = "/api/cameras/camA/frames"

    def test_list_frames_and_reference(self) -> None:
        body = self.client.get(self.base).json()
        self.assertEqual(body["frames"], self.frames)
        self.assertFalse(body["showing_all"])
        self.assertIsNone(body["reference_frame"])
        r = self.client.put("/api/cameras/camA/reference-frame", json={"frame": self.frames[1]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.get(self.base).json()["reference_frame"], self.frames[1])
        self.assertEqual(db.get_setting("camA", "reference_frame"), self.frames[1])

    def test_reference_must_be_a_real_frame(self) -> None:
        r = self.client.put("/api/cameras/camA/reference-frame", json={"frame": "nope.png"})
        self.assertEqual(r.status_code, 404)

    def test_full_image_served_unchanged(self) -> None:
        r = self.client.get(f"{self.base}/{self.frames[0]}/image")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/png")
        on_disk = (datamodel.unsorted_dir("camA") / self.frames[0]).read_bytes()
        self.assertEqual(r.content, on_disk)

    def test_tiff_is_converted_to_png(self) -> None:
        img = np.full((10, 12, 3), 90, dtype=np.uint8)
        cv2.imwrite(str(datamodel.unsorted_dir("camA") / "scan.tif"), img)
        r = self.client.get(f"{self.base}/scan.tif/image")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/png")
        decoded = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(decoded.shape[:2], (10, 12))

    def test_traversal_and_unknown_frames_are_404(self) -> None:
        for name in ["..%2F..%2Fdata%2Fx.png", "missing.png", "frame_000.txt", "%2Fetc%2Fpasswd"]:
            self.assertEqual(self.client.get(f"{self.base}/{name}/image").status_code, 404, name)
            self.assertEqual(self.client.get(f"{self.base}/{name}/thumb").status_code, 404, name)

    def test_thumb_is_cropped_to_roi(self) -> None:
        r = self.client.get(f"{self.base}/{self.frames[0]}/thumb", params={"feature": "seal"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/jpeg")
        img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(img.shape[:2], (20, 30))  # half of the 40x60 frame

    def test_square_variant_and_size_bounds(self) -> None:
        r = self.client.get(f"{self.base}/{self.frames[0]}/thumb", params={"feature": "seal", "variant": "square", "size": 64})
        img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(img.shape[:2], (64, 64))
        self.assertEqual(self.client.get(f"{self.base}/{self.frames[0]}/thumb", params={"size": 5}).status_code, 422)
        self.assertEqual(self.client.get(f"{self.base}/{self.frames[0]}/thumb", params={"variant": "x"}).status_code, 422)

    def test_thumb_etag_revalidation_and_roi_change(self) -> None:
        url = f"{self.base}/{self.frames[0]}/thumb"
        first = self.client.get(url, params={"feature": "seal"})
        etag = first.headers["etag"]
        again = self.client.get(url, params={"feature": "seal"}, headers={"If-None-Match": etag})
        self.assertEqual(again.status_code, 304)
        datamodel.save_rois("camA", [ROI(name="seal", x=0.0, y=0.0, w=1.0, h=1.0)])
        moved = self.client.get(url, params={"feature": "seal"}, headers={"If-None-Match": etag})
        self.assertEqual(moved.status_code, 200)
        self.assertNotEqual(moved.headers["etag"], etag)

    def test_no_feature_means_whole_frame(self) -> None:
        r = self.client.get(f"{self.base}/{self.frames[0]}/thumb")
        img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(img.shape[:2], (40, 60))
