from __future__ import annotations

import tags
from tests.api_helpers import ApiTestCase, write_frames


class CameraTagsTests(ApiTestCase):
    def test_clean_trims_collapses_and_dedupes_case_insensitively(self) -> None:
        self.assertEqual(tags.clean(["  night  shift ", "Night Shift", "", "new lens"]), ["night shift", "new lens"])

    def test_clean_rejects_long_and_too_many(self) -> None:
        with self.assertRaises(tags.TagError):
            tags.clean(["x" * 41])
        with self.assertRaises(tags.TagError):
            tags.clean([f"t{i}" for i in range(21)])

    def test_put_and_get_and_overview(self) -> None:
        write_frames("camA", 1)
        self.assertEqual(self.client.get("/api/cameras/camA/tags").json(), [])
        r = self.client.put("/api/cameras/camA/tags", json={"tags": ["Line 1", "line 1", "trial"]})
        self.assertEqual(r.json(), ["Line 1", "trial"])
        self.assertEqual(self.client.get("/api/overview").json()["cameras"][0]["tags"], ["Line 1", "trial"])

    def test_unknown_camera_and_bad_tags(self) -> None:
        self.assertEqual(self.client.put("/api/cameras/nope/tags", json={"tags": ["a"]}).status_code, 404)
        write_frames("camA", 1)
        self.assertEqual(self.client.put("/api/cameras/camA/tags", json={"tags": ["x" * 50]}).status_code, 422)

    def test_all_tags_counts_across_cameras_and_removal_is_per_camera(self) -> None:
        write_frames("camA", 1)
        write_frames("camB", 1)
        self.client.put("/api/cameras/camA/tags", json={"tags": ["trial", "Line 1"]})
        self.client.put("/api/cameras/camB/tags", json={"tags": ["TRIAL"]})
        self.assertEqual(self.client.get("/api/tags").json(), [{"tag": "trial", "count": 2}, {"tag": "Line 1", "count": 1}])
        self.client.put("/api/cameras/camA/tags", json={"tags": ["Line 1"]})
        self.assertEqual(self.client.get("/api/cameras/camB/tags").json(), ["TRIAL"])
        self.assertEqual(self.client.get("/api/tags").json(), [{"tag": "Line 1", "count": 1}, {"tag": "TRIAL", "count": 1}])

    def test_create_camera_with_tags(self) -> None:
        r = self.client.post("/api/cameras", json={"name": "camNew", "tags": [" a ", "b", "A"]})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json(), {"name": "camNew", "tags": ["a", "b"]})
        self.assertEqual(self.client.get("/api/cameras/camNew/tags").json(), ["a", "b"])

    def test_create_camera_with_bad_tag_creates_nothing(self) -> None:
        r = self.client.post("/api/cameras", json={"name": "camNew", "tags": ["x" * 50]})
        self.assertEqual(r.status_code, 422)
        self.assertNotIn("camNew", self.client.get("/api/cameras").json())
