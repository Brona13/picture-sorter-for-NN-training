from __future__ import annotations

from tests.api_helpers import ApiTestCase, write_frames

BOX = {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}


class OverviewApiTests(ApiTestCase):
    def test_no_cameras(self) -> None:
        self.assertEqual(self.client.get("/api/overview").json(), {"cameras": []})

    def test_cameras_with_rois_and_picture_frame(self) -> None:
        frames = write_frames("camA", 3)
        write_frames("camB", 1)
        self.client.put("/api/cameras/camA/rois", json={**BOX, "name": "seal"})
        body = self.client.get("/api/overview").json()
        a, b = body["cameras"]
        self.assertEqual((a["camera"], a["frame_count"], a["picture_frame"]), ("camA", 3, frames[0]))
        self.assertEqual([r["feature"] for r in a["rois"]], ["seal"])
        self.assertEqual((a["rois"][0]["x"], a["rois"][0]["h"]), (0.1, 0.4))
        self.assertEqual(b["rois"], [])

    def test_reference_frame_is_the_picture(self) -> None:
        frames = write_frames("camA", 3)
        self.client.put("/api/cameras/camA/reference-frame", json={"frame": frames[2]})
        self.assertEqual(self.client.get("/api/overview").json()["cameras"][0]["picture_frame"], frames[2])
