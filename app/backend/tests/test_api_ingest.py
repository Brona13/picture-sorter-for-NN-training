from __future__ import annotations

from pathlib import Path

import datamodel
from tests.api_helpers import ApiTestCase, png_bytes, wait_for_job


class IngestApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        datamodel.ensure_camera_dirs("camA")

    def upload(self, files):
        r = self.client.post(
            "/api/cameras/camA/ingest/upload",
            files=[("files", (name, data, "application/octet-stream")) for name, data in files],
        )
        self.assertEqual(r.status_code, 202, r.text)
        return wait_for_job(self.client, r.json()["id"])

    def test_create_camera_sanitizes_name(self) -> None:
        r = self.client.post("/api/cameras", json={"name": " My Cam/1 "})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["name"], "My-Cam-1")
        self.assertIn("My-Cam-1", self.client.get("/api/cameras").json())
        self.assertEqual(self.client.post("/api/cameras", json={"name": " ../ "}).status_code, 422)

    def test_upload_adds_frames_and_reports_progress(self) -> None:
        job = self.upload([("a.png", png_bytes(1)), ("b.png", png_bytes(2))])
        self.assertEqual(job["status"], "done", job)
        self.assertEqual(job["result"]["added"], 2)
        self.assertEqual(job["result"]["skipped"], [])
        self.assertEqual(job["result"]["errors"], [])
        self.assertEqual(len(datamodel.list_unsorted("camA")), 2)
        self.assertEqual(job["progress"]["phase"], "persistence")

    def test_duplicates_are_skipped_by_content(self) -> None:
        self.upload([("a.png", png_bytes(1))])
        job = self.upload([("renamed.png", png_bytes(1)), ("c.png", png_bytes(3))])
        self.assertEqual(job["result"]["added"], 1)
        self.assertEqual(job["result"]["skipped"], ["renamed.png"])
        self.assertEqual(len(datamodel.list_unsorted("camA")), 2)

    def test_unsupported_types_are_rejected_and_staging_cleaned(self) -> None:
        job = self.upload([("notes.txt", b"hello"), ("a.png", png_bytes(1))])
        self.assertEqual(job["result"]["added"], 1)
        self.assertEqual(len(job["result"]["errors"]), 1)
        self.assertIn("notes.txt", job["result"]["errors"][0])
        import tempfile

        leftovers = list(Path(tempfile.gettempdir()).glob("picture-sorter-upload-*"))
        self.assertEqual(leftovers, [])

    def test_path_in_filename_cannot_escape_camera_dir(self) -> None:
        job = self.upload([("../../evil.png", png_bytes(5))])
        self.assertEqual(job["result"]["added"], 1)
        names = [p.name for p in datamodel.list_unsorted("camA")]
        self.assertEqual(names, ["evil.png"])
        self.assertFalse((Path(self.tmp.name) / "evil.png").exists())

    def test_upload_validation(self) -> None:
        self.assertEqual(self.client.post("/api/cameras/nope/ingest/upload", files=[("files", ("a.png", b"x"))]).status_code, 404)
        self.assertEqual(self.client.post("/api/cameras/camA/ingest/upload").status_code, 422)

    def test_folder_import(self) -> None:
        src = Path(self.tmp.name) / "incoming"
        src.mkdir()
        (src / "x.png").write_bytes(png_bytes(10))
        (src / "y.png").write_bytes(png_bytes(11))
        (src / "readme.txt").write_text("ignored")
        r = self.client.post("/api/cameras/camA/ingest/folder", json={"path": str(src)})
        self.assertEqual(r.status_code, 202)
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["result"]["added"], 2)
        self.assertEqual((src / "x.png").read_bytes(), png_bytes(10))  # source untouched

    def test_folder_import_errors(self) -> None:
        r = self.client.post("/api/cameras/camA/ingest/folder", json={"path": str(Path(self.tmp.name) / "missing")})
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["result"]["added"], 0)
        self.assertIn("not a directory", job["result"]["errors"][0])
        self.assertEqual(self.client.post("/api/cameras/camA/ingest/folder", json={"path": "  "}).status_code, 422)

    def test_rebuild_catalog_after_external_changes(self) -> None:
        (datamodel.unsorted_dir("camA") / "ext.png").write_bytes(png_bytes(20))
        r = self.client.post("/api/cameras/camA/ingest/rebuild")
        self.assertEqual(r.status_code, 202)
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["result"], {"tracked": 1})

    def test_ingested_frames_list_has_original_name_and_time_newest_first_and_survives_a_rebuild(self) -> None:
        import time

        before = time.time()
        self.upload([("first.png", png_bytes(1))])
        time.sleep(0.02)
        self.upload([("second.png", png_bytes(2))])
        rows = self.client.get("/api/cameras/camA/ingest/frames").json()["frames"]
        self.assertEqual([r["name"] for r in rows], ["second.png", "first.png"])
        self.assertTrue(all(before <= r["created"] <= time.time() for r in rows))
        # rebuilding the catalog keeps the ingest times (it must not replace them with file times)
        self.assertEqual(wait_for_job(self.client, self.client.post("/api/cameras/camA/ingest/rebuild").json()["id"])["status"], "done")
        again = self.client.get("/api/cameras/camA/ingest/frames").json()["frames"]
        self.assertEqual({r["frame"]: r["created"] for r in again}, {r["frame"]: r["created"] for r in rows})

    def test_a_deleted_picture_is_not_listed(self) -> None:
        import db

        self.upload([("a.png", png_bytes(1)), ("b.png", png_bytes(2))])
        rows = self.client.get("/api/cameras/camA/ingest/frames").json()["frames"]
        db.mark_frames_deleted("camA", [(rows[0]["frame"], "h")])
        left = self.client.get("/api/cameras/camA/ingest/frames").json()["frames"]
        self.assertEqual([r["frame"] for r in left], [rows[1]["frame"]])
