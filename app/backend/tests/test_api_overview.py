from __future__ import annotations

import flow
import labels
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

    def test_flow_is_none_without_measurement_boxes(self) -> None:
        write_frames("camA", 1)
        self.assertIsNone(self.client.get("/api/overview").json()["cameras"][0]["flow"])

    def test_flow_lists_the_boxes_and_the_found_boxes_on_the_whole_picture(self) -> None:
        names = write_frames("camA", 2)
        crop = flow.create_node("camA", "crop")
        det = flow.create_node("camA", "detector")
        flow.add_target("camA", det, "P")
        graph = flow.load_graph("camA")
        graph["nodes"][crop]["rect"] = [0.5, 0.0, 0.5, 1.0]  # starts at x = 30 px of the 60 x 40 picture
        graph["edges"] = [{"source": crop, "target": det}]
        flow.save_graph("camA", graph)
        key = labels.hash_map("camA")[names[0]]
        flow._store("camA", det, None, {key: {"P": {"x": 10.0, "y": 20.0, "w": 8, "h": 6, "angle": 5.0, "source": "auto"}}})
        info = self.client.get("/api/overview").json()["cameras"][0]["flow"]
        self.assertEqual([(n["kind"], n["label"]) for n in info["nodes"]], [("crop", "Crop 1"), ("detector", "Detector 1")])
        self.assertEqual(info["size"], {"w": 60, "h": 40})
        self.assertEqual(
            info["boxes"],
            [{"detector": det, "target": "P", "x": 40.0, "y": 20.0, "w": 8, "h": 6, "angle": 5.0, "source": "auto"}],
        )
