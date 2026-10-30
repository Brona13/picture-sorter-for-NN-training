from __future__ import annotations

from unittest import mock

import numpy as np

import config
import datamodel
import db
import dedup
import embedding
import flow
import labels
import scatter
from api import dedup_api
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job, write_frames

CAM, ROI_NAME, FEAT = "camA", "seal", "dedup:1"  # FEAT is the Dedup box; the ROI is the Classifier it may read


class DedupApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 6)
        datamodel.save_rois(CAM, [ROI(name=ROI_NAME, x=0, y=0, w=1, h=1)])
        self.assertEqual(flow.create_node(CAM, "dedup"), FEAT)
        flow.connect(CAM, "ingest", FEAT)  # v1.107.0: a box with no line has no pictures
        dedup_api._results.clear()
        dedup_api._sweeps.clear()
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

    def sweep(self, **over):
        body = {"feature": FEAT, "method": "resnet50", "eps_from": 0.005, "eps_to": 0.03, "eps_step": 0.005, "mp_from": 2, "mp_to": 3, **over}
        r = self.client.post(f"{self.base}/sweep", json=body)
        self.assertEqual(r.status_code, 202, r.text)
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        return job["result"]

    def test_sweep_counts_clusters_and_would_mute_per_setting(self) -> None:
        res = self.sweep(eps_from=0.0005 + 0.0005, eps_to=0.01, eps_step=0.003)
        self.assertEqual(res["min_points"], [2, 3])
        self.assertEqual(res["frames"], 6)
        first = res["lines"][0]
        self.assertEqual(first["min_points"], 2)
        self.assertEqual(len(first["clusters"]), len(res["epsilons"]))
        self.assertEqual(first["clusters"][-1], 2)  # two near-duplicate groups at the widest Epsilon
        self.assertEqual(first["would_mute"][-1], 3)  # (3-1) + (2-1), as the Clusters tool says
        self.assertEqual(res["peak"]["clusters"], 2)
        self.assertEqual(self.client.get(f"{self.base}/sweep", params={"feature": FEAT}).json()["sweep"]["peak"], res["peak"])

    def test_sweep_is_dropped_when_the_vision_settings_change(self) -> None:
        self.sweep()
        with mock.patch.object(dedup_api.vision_settings, "epoch", return_value=10**9):
            self.assertIsNone(self.client.get(f"{self.base}/sweep", params={"feature": FEAT}).json()["sweep"])

    def test_sweep_rejects_ranges_that_are_out_of_bounds_or_too_big(self) -> None:
        base = {"feature": FEAT, "method": "resnet50", "eps_from": 0.005, "eps_to": 0.03, "eps_step": 0.005, "mp_from": 2, "mp_to": 4}
        for bad in ({"eps_to": 0.004}, {"eps_from": 0}, {"eps_to": 0.5}, {"eps_step": 0.00001}, {"mp_from": 5}, {"mp_to": 11},
                    {"eps_from": 0.001, "eps_to": 0.2, "eps_step": 0.0001}):
            self.assertEqual(self.client.post(f"{self.base}/sweep", json={**base, **bad}).status_code, 422, bad)
        self.assertIsNone(self.client.get(f"{self.base}/sweep", params={"feature": FEAT}).json()["sweep"])

    def test_mute_frames_by_hand_skips_goldens_and_other_boxes_are_untouched(self) -> None:
        other = flow.create_node(CAM, "dedup")
        flow.connect(CAM, "ingest", other)
        r = self.client.post(f"{self.base}/mute-frames", json={"feature": FEAT, "frames": self.frames[:2] + ["nope.png"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"muted": 2, "skipped_golden": 0, "already": 0})
        self.assertEqual(db.muted_frames(CAM, FEAT), set(self.frames[:2]))
        self.assertEqual(db.muted_frames(CAM, other), set())
        again = self.client.post(f"{self.base}/mute-frames", json={"feature": FEAT, "frames": self.frames[:3]}).json()
        self.assertEqual((again["muted"], again["already"]), (1, 2))
        self.assertEqual(self.client.post(f"{self.base}/mute-frames", json={"feature": FEAT, "frames": []}).status_code, 422)
        self.assertEqual(self.client.post(f"{self.base}/mute-frames", json={"feature": "dedup:99", "frames": self.frames[:1]}).status_code, 404)
        self.assertEqual(self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()["muted_count"], 3)
        # the box passes on its pictures minus the mutes: a box after it sees only the rest
        det = flow.create_node(CAM, "detector")
        flow.connect(CAM, FEAT, det)
        self.assertEqual(sorted(flow.node_frames(CAM, det)), sorted(self.frames[3:]))

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

    def read_classifier(self) -> None:
        """Label every picture on the ROI and make the box read its "all" dot."""
        for f in self.frames:
            labels.set_label(CAM, ROI_NAME, f, "OK")
        flow.update_node(CAM, FEAT, {"source": {"feature": ROI_NAME, "dot": "all"}})

    def test_a_standalone_box_has_no_labels_to_protect(self) -> None:
        labels.set_label(CAM, ROI_NAME, self.frames[0], "OK")  # a label of some ROI does not concern a box that reads the camera
        self.cluster()
        r = self.client.post(f"{self.base}/apply", json={"feature": FEAT}).json()
        self.assertEqual((r["skipped_labeled"], r["muted"]), (0, 3))

    def test_behind_a_classifier_labeled_frames_may_be_muted_but_a_golden_never(self) -> None:
        self.read_classifier()
        big_members = self.frames[:3]
        labels.mark_golden(CAM, ROI_NAME, big_members[1], "OK")
        res = self.cluster()["result"]
        big = next(c for c in res["clusters"] if len(c["members"]) == 3)
        r = self.client.post(f"{self.base}/apply", json={"feature": FEAT, "picks": {big["id"]: big_members[0]}}).json()
        self.assertEqual(r["skipped_golden"], 1)
        muted = db.muted_frames(CAM, FEAT)
        self.assertNotIn(big_members[1], muted)  # the golden stays
        self.assertIn(big_members[2], muted)  # labeled, muted all the same
        self.assertEqual(labels.current_labels(CAM, ROI_NAME)[big_members[2]], "OK")  # the label stays

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

    @staticmethod
    def _fake_project(frames, matrix, **kw):
        xy = np.stack([np.arange(len(frames), dtype=np.float32), np.zeros(len(frames), dtype=np.float32)], axis=1)
        return scatter.Projection(method=kw["method"], backbone=kw["backbone"], frames=list(frames), xy=xy, from_cache=False)

    def test_scatter_without_a_clustering_needs_an_embedding_and_has_no_clusters(self) -> None:
        url = f"{self.base}/scatter"
        self.assertEqual(self.client.post(url, json={"feature": FEAT}).status_code, 422)  # no clustering, no embedding named
        self.assertEqual(self.client.post(url, json={"feature": FEAT, "method": "vgg"}).status_code, 422)
        self.read_classifier()
        labels.set_label(CAM, ROI_NAME, self.frames[1], "NG")
        with mock.patch.object(scatter, "project", side_effect=self._fake_project):
            r = self.client.post(url, json={"feature": FEAT, "method": "resnet50"})
            self.assertEqual(r.status_code, 202, r.text)
            job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        res = job["result"]
        self.assertEqual(res["method"], "resnet50")
        pts = {p["frame"]: p for p in res["points"]}
        self.assertEqual(len(pts), 6)
        self.assertTrue(all(p["cluster"] is None and not p["representative"] for p in pts.values()))
        self.assertEqual(pts[self.frames[0]]["label"], "OK")  # the labels are the Classifier's
        self.assertEqual(pts[self.frames[1]]["label"], "NG")

    def test_scatter_of_another_embedding_than_the_clustering_has_no_cluster_ids(self) -> None:
        self.cluster()  # resnet50
        with mock.patch.object(scatter, "project", side_effect=self._fake_project):
            r = self.client.post(f"{self.base}/scatter", json={"feature": FEAT, "method": "resnet18"})
            job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        self.assertTrue(all(p["cluster"] is None for p in job["result"]["points"]))

    def test_scatter_returns_annotated_points_with_the_clusters_of_the_held_clustering(self) -> None:
        self.read_classifier()
        self.cluster()
        labels.set_label(CAM, ROI_NAME, self.frames[5], "NG")
        labels.mark_golden(CAM, ROI_NAME, self.frames[5], "NG")

        fake_project = self._fake_project
        with mock.patch.object(scatter, "project", side_effect=fake_project):
            r = self.client.post(f"{self.base}/scatter", json={"feature": FEAT, "projection": "tsne"})
            self.assertEqual(r.status_code, 202)
            job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        pts = {p["frame"]: p for p in job["result"]["points"]}
        self.assertEqual(len(pts), 6)
        self.assertEqual(pts[self.frames[5]]["golden"], "NG")
        self.assertEqual(pts[self.frames[5]]["cluster"], -1)
        self.assertEqual(pts[self.frames[5]]["label"], "NG")
        self.assertEqual(sum(p["representative"] for p in pts.values()), 2)
        self.assertEqual(self.client.post(f"{self.base}/scatter", json={"feature": FEAT, "projection": "pca"}).status_code, 422)

    def _store_projection(self, frames: list[str], method: str = "umap", backbone: str = "resnet50") -> None:
        import json

        xy = [[float(i), float(i)] for i in range(len(frames))]
        db.save_scatter(CAM, FEAT, method, backbone, "sig", json.dumps({"frames": frames, "xy": xy}).encode("utf-8"))

    def cached(self, **over) -> bool:
        params = {"feature": FEAT, "projection": "umap", "method": "resnet50", **over}
        r = self.client.get(f"{self.base}/scatter/cached", params=params)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["cached"]

    def test_scatter_cached_probe_tells_when_the_map_needs_no_computing(self) -> None:
        self.assertFalse(self.cached())
        self._store_projection(self.frames)
        self.assertTrue(self.cached())
        self.assertFalse(self.cached(method="resnet18"))
        self.assertFalse(self.cached(projection="tsne"))

    def test_scatter_cached_probe_accepts_frames_removed_since_but_not_new_ones(self) -> None:
        self._store_projection([*self.frames, "deleted-since.png"])
        self.assertTrue(self.cached())
        self._store_projection(self.frames[:-1])  # a frame was added after the projection
        self.assertFalse(self.cached())

    def test_scatter_cached_probe_rejects_unknown_projection_and_feature(self) -> None:
        self.assertEqual(self.client.get(f"{self.base}/scatter/cached", params={"feature": FEAT, "projection": "pca", "method": "resnet50"}).status_code, 422)
        self.assertEqual(self.client.get(f"{self.base}/scatter/cached", params={"feature": "nope", "projection": "umap", "method": "resnet50"}).status_code, 404)

    def test_scatter_missing_optional_dependency_is_reported(self) -> None:
        self.cluster()
        with mock.patch.object(scatter, "project", side_effect=ImportError("umap")):
            r = self.client.post(f"{self.base}/scatter", json={"feature": FEAT})
            job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "error")
        self.assertIn("umap-learn", job["error"])

    def test_cluster_with_no_frames(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=ROI_NAME, x=0, y=0, w=1, h=1), ROI(name="p", x=0, y=0, w=1, h=1, role="classify", classes=["A", "B"])])
        r = self.client.post(f"/api/cameras/{CAM}/dedup/cluster", json={**self.params, "feature": "A::rod"})
        self.assertEqual(r.status_code, 404)  # unknown feature

    def test_changed_vision_settings_drop_the_held_clustering(self) -> None:
        """Embeddings (and projections built on them) describe the old filter/mask crops."""
        self.cluster()
        self.assertIsNotNone(self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()["result"])
        r = self.client.put(
            f"/api/cameras/{CAM}/vision/{ROI_NAME}",
            json={"mask": {"enabled": True, "shape": {"shape": "rect", "x": 0, "y": 0, "w": 0.5, "h": 0.5}}},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()["result"])
        # the dropped clustering no longer supplies an embedding, nor cluster ids for a projection
        self.assertEqual(self.client.post(f"{self.base}/scatter", json={"feature": FEAT}).status_code, 422)
        self.cluster()  # clustering again works on the new crops
        self.assertIsNotNone(self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()["result"])
