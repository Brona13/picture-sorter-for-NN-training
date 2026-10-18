"""Deleting a camera removes everything related to it and nothing of any other camera."""
from __future__ import annotations

import time

import config
import datamodel
import db
import labels
from api import jobs
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

GONE, KEPT = "camGone", "camKept"
EXPECTED_TABLES = {
    "frames", "rois", "labels", "goldens", "deleted_frames", "dedup_mute", "versions", "verdict_decisions",
    "settings", "cluster_snapshot", "scatter_cache", "results_cache", "detections", "version_items", "version_results",
}


def fill(camera: str) -> list[str]:
    """A camera with pictures, ROIs, a label, a golden, settings of two pages, a version and cached vectors."""
    frames = write_frames(camera, 3)
    datamodel.save_rois(camera, [ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"]), ROI("seal", 0, 0, 1, 1)])
    labels.set_label(camera, "seal", frames[0], "OK")
    labels.mark_golden(camera, "seal", frames[0], "OK")
    db.set_setting(camera, "chain.canvas", '{"nodes": {}, "viewport": null}')
    db.set_setting(camera, "vision.seal", "{}")
    (datamodel.camera_dir(camera) / "exports").mkdir(exist_ok=True)
    (datamodel.camera_dir(camera) / "exports" / "v1.txt").write_text("export")
    con = db.connect()
    try:
        con.execute("INSERT INTO versions(camera,feature,number,name,created) VALUES (?,?,?,?,?)", (camera, "seal", 1, "v1", time.time()))
        vid = con.execute("SELECT id FROM versions WHERE camera=?", (camera,)).fetchone()[0]
        con.execute("INSERT INTO version_items(version_id,frame,hash,kind,class) VALUES (?,?,?,?,?)", (vid, frames[0], "h", "label", "OK"))
        con.execute("INSERT INTO version_results(version_id,name,value,measured,created) VALUES (?,?,?,?,?)", (vid, "m", 1.0, "2026-10-18", time.time()))
        con.commit()
    finally:
        con.close()
    return frames


def cache_vector(hash_: str) -> None:
    con = db.connect()
    try:
        con.execute("INSERT INTO score_cache(hash,feature,roi_key,kind,vec,ts) VALUES (?,?,?,?,?,?)", (hash_, "seal", "k", "cpu", b"\x00", 0.0))
        con.commit()
    finally:
        con.close()


def rows_of(camera: str) -> dict[str, int]:
    return db.camera_row_counts(camera)


class CameraDeleteTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.gone_frames = fill(GONE)
        fill(KEPT)

    def delete(self, camera: str = GONE, confirm: str | None = GONE):
        suffix = "" if confirm is None else f"?confirm={confirm}"
        return self.client.delete(f"/api/cameras/{camera}{suffix}")

    def test_the_schema_tables_with_a_camera_column_are_all_found(self) -> None:
        con = db.connect()
        try:
            self.assertEqual(set(db._camera_tables(con)) | {"version_items", "version_results"}, EXPECTED_TABLES)
        finally:
            con.close()

    def test_delete_removes_every_trace_of_the_camera(self) -> None:
        self.assertEqual(set(rows_of(GONE)), {"frames", "rois", "labels", "goldens", "settings", "versions"})
        r = self.delete()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(rows_of(GONE), {})
        self.assertFalse(datamodel.camera_dir(GONE).exists())
        self.assertNotIn(GONE, self.client.get("/api/cameras").json())
        con = db.connect()
        try:
            for table in ("version_items", "version_results"):
                self.assertEqual(con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 1, table)
        finally:
            con.close()

    def test_the_response_counts_what_was_removed(self) -> None:
        removed = self.delete().json()["removed"]
        self.assertEqual(removed["rows"]["frames"], 3)
        self.assertEqual(removed["rows"]["rois"], 2)
        self.assertEqual(removed["rows"]["labels"], 1)
        self.assertGreaterEqual(removed["files"], 4)

    def test_other_cameras_are_untouched(self) -> None:
        before = rows_of(KEPT)
        self.delete()
        self.assertEqual(rows_of(KEPT), before)
        self.assertEqual(len(datamodel.list_unsorted(KEPT)), 3)
        self.assertTrue((datamodel.camera_dir(KEPT) / "exports" / "v1.txt").exists())
        self.assertEqual(db.get_setting(KEPT, "chain.canvas"), '{"nodes": {}, "viewport": null}')

    def test_cached_vectors_go_unless_another_camera_has_the_same_picture(self) -> None:
        con = db.connect()
        try:
            gone_hashes = [r[0] for r in con.execute("SELECT hash FROM frames WHERE camera=? ORDER BY filename", (GONE,))]
            kept_hashes = {r[0] for r in con.execute("SELECT hash FROM frames WHERE camera=?", (KEPT,))}
        finally:
            con.close()
        shared = next(h for h in gone_hashes if h in kept_hashes)  # write_frames makes the same synthetic pictures
        cache_vector(shared)
        cache_vector(shared + "@1,2")
        cache_vector("other-camera-only")
        self.delete()
        con = db.connect()
        try:
            left = {r[0] for r in con.execute("SELECT hash FROM score_cache")}
        finally:
            con.close()
        self.assertEqual(left, {shared, shared + "@1,2", "other-camera-only"})

    def test_cached_vectors_only_this_camera_used_are_removed(self) -> None:
        con = db.connect()
        try:
            con.execute("UPDATE frames SET hash='only-gone' WHERE camera=? AND filename=?", (GONE, self.gone_frames[1]))
            con.commit()
        finally:
            con.close()
        cache_vector("only-gone")
        cache_vector("only-gone@3,4")
        self.delete()
        con = db.connect()
        try:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM score_cache").fetchone()[0], 0)
        finally:
            con.close()

    def test_the_name_must_be_repeated_to_confirm(self) -> None:
        for confirm in (None, "", "camKept", "camgone"):
            self.assertEqual(self.delete(confirm=confirm).status_code, 422, confirm)
        self.assertTrue(datamodel.camera_dir(GONE).exists())
        self.assertGreater(len(rows_of(GONE)), 0)

    def test_unknown_camera_is_404_and_nothing_else_is_touched(self) -> None:
        self.assertEqual(self.delete("nope", "nope").status_code, 404)
        self.assertIn(self.delete("..", "..").status_code, (404, 405))  # the client may fold ".." away; never a delete
        self.assertTrue(config.CAMERAS_ROOT.exists())

    def test_a_running_job_blocks_the_delete(self) -> None:
        job = jobs.Job(id="j1", kind="score", camera=GONE, status=jobs.RUNNING)
        jobs.registry._jobs["j1"] = job
        try:
            self.assertEqual(self.delete().status_code, 409)
            self.assertTrue(datamodel.camera_dir(GONE).exists())
        finally:
            del jobs.registry._jobs["j1"]

    def test_preview_counts_rows_and_files(self) -> None:
        p = self.client.get(f"/api/cameras/{GONE}/delete-preview").json()
        self.assertEqual(p["rows"]["frames"], 3)
        self.assertGreaterEqual(p["files"], 4)
        self.assertGreater(p["bytes"], 0)
        self.assertEqual(self.client.get("/api/cameras/nope/delete-preview").status_code, 404)

    def test_a_camera_can_be_created_again_empty(self) -> None:
        self.delete()
        self.client.post("/api/cameras", json={"name": GONE, "tags": []})
        self.assertEqual(rows_of(GONE), {})
        self.assertEqual(datamodel.list_unsorted(GONE), [])


if __name__ == "__main__":
    import unittest

    unittest.main()
