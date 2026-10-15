"""Camera-wide soft delete: notes, bulk delete/restore, dedup and scatter exclusion."""
from __future__ import annotations

import time
from unittest import mock

import numpy as np

import datamodel
import db
import dedup
import embedding
import labels
import scatter
from api import dedup_api
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job, write_frames

CAM, FEAT, OTHER = "camA", "seal", "rod"


class DeletedFramesTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 6)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1), ROI(name=OTHER, x=0, y=0, w=1, h=1)])
        dedup_api._results.clear()
        vecs = {0: [1, 0, 0], 1: [1, 0.001, 0], 2: [1, 0, 0.001], 3: [0, 1, 0], 4: [0, 1, 0.001], 5: [0, 0, 1]}

        def fake_fetch(camera, feature, frames, backbone, progress_cb=None):
            idx = {f: i for i, f in enumerate(self.frames)}
            m = np.array([vecs[idx[f]] for f in frames], dtype=np.float32)
            m /= np.linalg.norm(m, axis=1, keepdims=True)
            return list(frames), m

        self.patches = [
            mock.patch.object(embedding, "backbones", return_value=["resnet50"]),
            mock.patch.object(dedup, "fetch_embeddings", side_effect=fake_fetch),
        ]
        for p in self.patches:
            p.start()
        self.cls = f"/api/cameras/{CAM}/classify"
        self.dd = f"/api/cameras/{CAM}/dedup"
        self.params = {"feature": FEAT, "method": "resnet50", "epsilon": 0.05, "min_points": 2}

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()
        dedup_api._results.clear()
        super().tearDown()

    def cluster(self) -> dict:
        r = self.client.post(f"{self.dd}/cluster", json=self.params)
        self.assertEqual(r.status_code, 202, r.text)
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        return job["result"]

    def delete_bulk(self, frames: list[str], note: str = "") -> dict:
        r = self.client.post(f"{self.cls}/delete-bulk", json={"feature": FEAT, "frames": frames, "note": note})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_delete_stores_time_and_note_and_lists_newest_first(self) -> None:
        before = time.time()
        self.delete_bulk([self.frames[0]], note="  foreign   object ")
        time.sleep(0.01)
        self.client.post(f"{self.cls}/delete", json={"feature": FEAT, "frame": self.frames[1]})
        items = self.client.get(f"{self.cls}/deleted", params={"feature": FEAT}).json()["items"]
        self.assertEqual([i["frame"] for i in items], [self.frames[1], self.frames[0]])
        self.assertGreaterEqual(items[1]["deleted_at"], before)
        self.assertEqual(items[1]["note"], "foreign object")
        self.assertEqual(items[0]["note"], "")

    def test_note_can_be_edited_later_without_changing_the_time(self) -> None:
        self.delete_bulk([self.frames[0]])
        first = self.client.get(f"{self.cls}/deleted", params={"feature": FEAT}).json()["items"][0]
        r = self.client.put(f"{self.cls}/deleted-note", json={"feature": FEAT, "frame": self.frames[0], "note": "blurred"})
        self.assertEqual(r.json()["note"], "blurred")
        again = self.client.get(f"{self.cls}/deleted", params={"feature": FEAT}).json()["items"][0]
        self.assertEqual((again["note"], again["deleted_at"]), ("blurred", first["deleted_at"]))
        r = self.client.put(f"{self.cls}/deleted-note", json={"feature": FEAT, "frame": self.frames[2], "note": "x"})
        self.assertEqual(r.status_code, 404)

    def test_delete_clears_labels_and_goldens_in_every_feature_and_preview_counts_them(self) -> None:
        f0, f1 = self.frames[0], self.frames[1]
        labels.set_label(CAM, FEAT, f0, "OK")
        labels.mark_golden(CAM, OTHER, f0, "OK")
        labels.set_label(CAM, FEAT, f1, "NG")
        pv = self.client.post(f"{self.cls}/delete-preview", json={"feature": FEAT, "frames": [f0, f1, self.frames[2]]}).json()
        self.assertEqual(pv, {"total": 3, "labeled": 2, "golden": 1})
        out = self.delete_bulk([f0, f1])
        self.assertEqual(out["deleted"], 2)
        self.assertEqual(labels.current_labels(CAM, FEAT), {})
        self.assertEqual(labels.current_labels(CAM, OTHER), {})
        self.assertEqual(labels.current_goldens(CAM, OTHER).get("OK", []), [])
        self.assertEqual(self.client.post(f"{self.cls}/delete-bulk", json={"feature": FEAT, "frames": []}).status_code, 422)

    def test_restore_bulk_brings_frames_back_clean(self) -> None:
        self.delete_bulk(self.frames[:3])
        r = self.client.post(f"{self.cls}/restore-bulk", json={"feature": FEAT, "frames": self.frames[:2]})
        self.assertEqual(r.json(), {"restored": 2})
        self.assertEqual(db.deleted_frames_of(CAM), {self.frames[2]})

    def test_cluster_leaves_deleted_frames_out(self) -> None:
        self.delete_bulk([self.frames[0]])
        res = self.cluster()
        members = {f for c in res["clusters"] for f in c["members"]} | set(res["noise_frames"])
        self.assertNotIn(self.frames[0], members)
        self.assertEqual(res["summary"]["total"], 5)

    def test_deleting_after_clustering_reclusters_the_held_result(self) -> None:
        self.assertEqual(self.cluster()["summary"], {"clusters": 2, "covered": 5, "unique": 1, "total": 6})
        self.delete_bulk([self.frames[3], self.frames[4]])
        st = self.client.get(f"{self.dd}/state", params={"feature": FEAT}).json()
        self.assertEqual(st["result"]["summary"], {"clusters": 1, "covered": 3, "unique": 1, "total": 4})
        gone = {self.frames[3], self.frames[4]}
        members = {f for c in st["result"]["clusters"] for f in c["members"]} | set(st["result"]["noise_frames"])
        self.assertFalse(gone & members)

    def test_scatter_keeps_layout_of_remaining_frames_after_a_delete(self) -> None:
        frames = self.frames
        matrix = np.eye(6, dtype=np.float32)
        xy = np.array([[i, i * 2] for i in range(6)], dtype=np.float32)
        scatter._save_cached(CAM, FEAT, "umap", "resnet50", scatter.frames_signature(frames), frames, xy)
        keep = [frames[0], frames[2], frames[3], frames[5], frames[4]]
        with mock.patch.object(scatter, "_umap", side_effect=AssertionError("must not re-project")):
            proj = scatter.project(keep, matrix[[0, 2, 3, 5, 4]], camera=CAM, feature=FEAT, backbone="resnet50", method="umap")
        self.assertTrue(proj.from_cache)
        self.assertEqual(proj.xy.tolist(), [[0, 0], [2, 4], [3, 6], [5, 10], [4, 8]])
        # a frame that was never projected forces a real projection
        new = keep + ["new.png"]
        with mock.patch.object(scatter, "_umap", return_value=np.zeros((6, 2), dtype=np.float32)) as um:
            scatter.project(new, np.zeros((6, 6), dtype=np.float32), camera=CAM, feature=FEAT, backbone="resnet50", method="umap")
        um.assert_called_once()


class DeletedNoteMigrationTests(ApiTestCase):
    def test_v5_database_gains_the_note_column_and_keeps_rows(self) -> None:
        con = db.connect()
        con.execute("INSERT INTO deleted_frames(camera,frame,hash,source,updated) VALUES('c','a.png','h','user',1.0)")
        con.execute("ALTER TABLE deleted_frames DROP COLUMN note")
        con.execute("PRAGMA user_version = 5")
        con.commit()
        con.close()
        con = db.connect()
        try:
            cols = {r[1] for r in con.execute("PRAGMA table_info(deleted_frames)")}
            row = con.execute("SELECT frame,note FROM deleted_frames").fetchone()
            version = con.execute("PRAGMA user_version").fetchone()[0]
        finally:
            con.close()
        self.assertIn("note", cols)
        self.assertEqual((row["frame"], row["note"]), ("a.png", ""))
        self.assertEqual(version, db.SCHEMA_VERSION)
