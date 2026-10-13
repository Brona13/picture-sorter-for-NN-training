from __future__ import annotations

from unittest import mock

import numpy as np

import config
import datamodel
import db
import dedup
import embedding
import labels
import scatter
from api import dedup_api
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job, write_frames

CAM, FEAT = "camA", "seal"


class DedupApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 6)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        dedup_api._results.clear()
        # Fake embeddings: frames 0-2 are near-identical, 3-4 near-identical, 5 is unique.
        vecs = {0: [1, 0, 0], 1: [1, 0.001, 0], 2: [1, 0, 0.001], 3: [0, 1, 0], 4: [0, 1, 0.001], 5: [0, 0, 1]}

        def fake_fetch(camera, feature, frames, backbone, progress_cb=None):
            idx = {f: i for i, f in enumerate(self.frames)}
            m = np.array([vecs[idx[f]] for f in frames], dtype=np.float32)
            m /= np.linalg.norm(m, axis=1, keepdims=True)
            if progress_cb:
                progress_cb(len(frames), len(frames))
            return list(frames), m

        self.patches = [
            mock.patch.object(embedding, "backbones", return_value=["resnet18", "resnet50"]),
            mock.patch.object(dedup, "fetch_embeddings", side_effect=fake_fetch),
        ]
        for p in self.patches:
            p.start()
        self.base = f"/api/cameras/{CAM}/dedup"
        self.params = {"feature": FEAT, "method": "resnet50", "epsilon": 0.05, "min_points": 2}

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()
        dedup_api._results.clear()
        super().tearDown()

    def cluster(self, **over):
        r = self.client.post(f"{self.base}/cluster", json={**self.params, **over})
        self.assertEqual(r.status_code, 202, r.text)
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        return job

    def test_state_defaults_and_availability(self) -> None:
        st = self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()
        self.assertIsNone(st["reason"])
        self.assertEqual(st["backbones"], ["resnet18", "resnet50"])
        self.assertEqual(st["params"], {"method": "resnet50", "epsilon": 0.02, "min_points": 2})
        self.assertEqual((st["frames"], st["muted_count"], st["result"]), (6, 0, None))
        with mock.patch.object(embedding, "backbones", return_value=[]):
            self.assertEqual(self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()["reason"], "no_embeddings")
            self.assertEqual(self.client.post(f"{self.base}/cluster", json=self.params).status_code, 409)

    def test_settings_validate_and_persist(self) -> None:
        r = self.client.put(f"{self.base}/settings", json={**self.params, "method": "resnet18", "epsilon": 0.07, "min_points": 3})
        self.assertEqual(r.json()["params"], {"method": "resnet18", "epsilon": 0.07, "min_points": 3})
        self.assertEqual(self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()["params"]["epsilon"], 0.07)
        for bad in ({"epsilon": 0.5}, {"epsilon": 0}, {"min_points": 1}, {"min_points": 11}, {"method": "vgg"}):
            self.assertEqual(self.client.put(f"{self.base}/settings", json={**self.params, **bad}).status_code, 422, bad)

    def test_cluster_groups_near_duplicates(self) -> None:
        job = self.cluster()
        res = job["result"]
        self.assertEqual(res["summary"], {"clusters": 2, "covered": 5, "unique": 1, "total": 6})
        by_size = [c["members"] for c in res["clusters"]]
        self.assertEqual(sorted(map(sorted, by_size)), [sorted(self.frames[:3]), sorted(self.frames[3:5])])
        self.assertEqual(res["noise_frames"], [self.frames[5]])
        self.assertEqual(res["would_mute"], 3)  # (3-1) + (2-1)
        self.assertEqual(job["progress"]["phase"], "embedding")
        st = self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()
        self.assertEqual(st["result"]["summary"], res["summary"])

    def test_apply_mutes_non_representatives_only_and_keeps_sources(self) -> None:
        res = self.cluster()["result"]
        big = next(c for c in res["clusters"] if len(c["members"]) == 3)
        keep = big["members"][2]  # override the representative
        r = self.client.post(f"{self.base}/apply", json={"feature": FEAT, "picks": {big["id"]: keep}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["muted"], 3)
        muted = db.muted_frames(CAM, FEAT)
        self.assertNotIn(keep, muted)
        self.assertNotIn(self.frames[5], muted)  # noise is never muted
        self.assertEqual(len(muted), 3)
        self.assertEqual(len(datamodel.list_unsorted(CAM)), 6)  # files untouched
        # result is consumed; applying again needs a new clustering
        self.assertEqual(self.client.post(f"{self.base}/apply", json={"feature": FEAT}).status_code, 409)
        self.assertEqual(self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()["muted_count"], 3)
        snap = dedup.load_snapshot(CAM, FEAT)
        self.assertTrue(snap[keep][1])  # representative flag recorded for Classify's chips

    def test_apply_never_mutes_labeled_or_golden_frames(self) -> None:
        res = self.cluster()["result"]
        big = next(c for c in res["clusters"] if len(c["members"]) == 3)
        victim = next(f for f in big["members"] if f != big["representative"])
        labels.set_label(CAM, FEAT, victim, "OK")
        r = self.client.post(f"{self.base}/apply", json={"feature": FEAT}).json()
        self.assertEqual(r["skipped_labeled"], 1)
        self.assertNotIn(victim, db.muted_frames(CAM, FEAT))

    def test_apply_rejects_foreign_representative(self) -> None:
        res = self.cluster()["result"]
        big = next(c for c in res["clusters"] if len(c["members"]) == 3)
        r = self.client.post(f"{self.base}/apply", json={"feature": FEAT, "picks": {big["id"]: self.frames[5]}})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(db.muted_frames(CAM, FEAT), set())
        self.assertEqual(self.client.post(f"{self.base}/apply", json={"feature": FEAT, "picks": {99: "x"}}).status_code, 422)

    def test_unmute_all(self) -> None:
        self.cluster()
        self.client.post(f"{self.base}/apply", json={"feature": FEAT})
        self.assertGreater(len(db.muted_frames(CAM, FEAT)), 0)
        r = self.client.delete(f"{self.base}/mutes", params={"feature": FEAT})
        self.assertEqual(r.json()["unmuted"], 3)
        self.assertEqual(db.muted_frames(CAM, FEAT), set())

    def test_scatter_needs_a_clustering_then_returns_annotated_points(self) -> None:
        self.assertEqual(self.client.post(f"{self.base}/scatter", json={"feature": FEAT}).status_code, 409)
        self.cluster()
        labels.set_label(CAM, FEAT, self.frames[5], "NG")
        labels.mark_golden(CAM, FEAT, self.frames[5], "NG")

        def fake_project(frames, matrix, **kw):
            xy = np.stack([np.arange(len(frames), dtype=np.float32), np.zeros(len(frames), dtype=np.float32)], axis=1)
            return scatter.Projection(method=kw["method"], backbone=kw["backbone"], frames=list(frames), xy=xy, from_cache=False)

        with mock.patch.object(scatter, "project", side_effect=fake_project):
            r = self.client.post(f"{self.base}/scatter", json={"feature": FEAT, "projection": "tsne"})
            self.assertEqual(r.status_code, 202)
            job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        pts = {p["frame"]: p for p in job["result"]["points"]}
        self.assertEqual(len(pts), 6)
        self.assertEqual(pts[self.frames[5]]["golden"], "NG")
        self.assertEqual(pts[self.frames[5]]["cluster"], -1)
        self.assertEqual(sum(p["representative"] for p in pts.values()), 2)
        self.assertEqual(self.client.post(f"{self.base}/scatter", json={"feature": FEAT, "projection": "pca"}).status_code, 422)

    def test_scatter_missing_optional_dependency_is_reported(self) -> None:
        self.cluster()
        with mock.patch.object(scatter, "project", side_effect=ImportError("umap")):
            r = self.client.post(f"{self.base}/scatter", json={"feature": FEAT})
            job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "error")
        self.assertIn("umap-learn", job["error"])

    def test_cluster_with_no_frames(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1), ROI(name="p", x=0, y=0, w=1, h=1, role="classify", classes=["A", "B"])])
        r = self.client.post(f"/api/cameras/{CAM}/dedup/cluster", json={**self.params, "feature": "A::rod"})
        self.assertEqual(r.status_code, 404)  # unknown feature
