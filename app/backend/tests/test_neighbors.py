from __future__ import annotations

from unittest import mock

import numpy as np

import datamodel
import db
import dedup
import embedding
import labels
import neighbors
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job, write_frames

CAM, FEAT = "camA", "seal"


class RankTests(ApiTestCase):
    def test_nearest_first_excluding_seed_and_non_candidates(self) -> None:
        frames = ["a", "b", "c", "d", "e"]
        m = np.array([[1, 0], [1, 0.05], [1, 0.5], [0, 1], [1, 0.01]], dtype=np.float32)
        ranked = neighbors.rank_candidates(frames, m, "a", {"b", "c", "d"}, limit=10)
        self.assertEqual([f for f, _ in ranked], ["b", "c", "d"])  # e is not a candidate, a is the seed
        d = [x for _, x in ranked]
        self.assertEqual(d, sorted(d))
        self.assertAlmostEqual(d[-1], 1.0, places=5)

    def test_limit_and_unknown_seed(self) -> None:
        m = np.eye(3, dtype=np.float32)
        self.assertEqual(len(neighbors.rank_candidates(["a", "b", "c"], m, "a", {"b", "c"}, limit=1)), 1)
        self.assertEqual(neighbors.rank_candidates(["a", "b"], m[:2], "zz", {"a", "b"}, limit=5), [])


class SimilarApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 7)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        # 0 is the seed; 1-3 close to it, 4 far, 5 close but labeled, 6 close but muted by Dedup.
        vecs = {0: [1, 0, 0], 1: [1, 0.01, 0], 2: [1, 0.05, 0], 3: [1, 0.2, 0], 4: [0, 0, 1], 5: [1, 0.02, 0], 6: [1, 0.03, 0]}

        def fake_fetch(camera, feature, frames, backbone, progress_cb=None):
            idx = {f: i for i, f in enumerate(self.frames)}
            m = np.array([vecs[idx[f]] for f in frames], dtype=np.float32)
            if progress_cb:
                progress_cb(len(frames), len(frames))
            return list(frames), m

        self.patches = [
            mock.patch.object(embedding, "backbones", return_value=["resnet18", "resnet50"]),
            mock.patch.object(dedup, "fetch_embeddings", side_effect=fake_fetch),
        ]
        for p in self.patches:
            p.start()
        labels.set_label(CAM, FEAT, self.frames[0], "OK")
        labels.set_label(CAM, FEAT, self.frames[5], "NG")
        db.add_dedup_mutes(CAM, FEAT, [(self.frames[6], labels.hash_map(CAM)[self.frames[6]], 0)])
        self.base = f"/api/cameras/{CAM}/classify"
        self.body = {"feature": FEAT, "frame": self.frames[0], "method": "resnet50"}

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()
        super().tearDown()

    def similar(self, **over):
        r = self.client.post(f"{self.base}/similar", json={**self.body, **over})
        self.assertEqual(r.status_code, 202, r.text)
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        return job["result"]

    def test_neighbours_are_unlabeled_nearest_first(self) -> None:
        res = self.similar()
        names = [n["frame"] for n in res["neighbors"]]
        self.assertEqual(names, [self.frames[i] for i in (1, 2, 3, 4)])  # 0 is the seed, 5 is labeled, 6 is muted by Dedup
        self.assertEqual(res["seed"], {"frame": self.frames[0], "label": "OK"})
        d = [n["distance"] for n in res["neighbors"]]
        self.assertEqual(d, sorted(d))

    def test_limit(self) -> None:
        self.assertEqual(len(self.similar(limit=2)["neighbors"]), 2)

    def test_deleted_frames_are_not_offered(self) -> None:
        db.mark_frames_deleted(CAM, [(self.frames[1], labels.hash_map(CAM)[self.frames[1]])])
        self.assertNotIn(self.frames[1], [n["frame"] for n in self.similar()["neighbors"]])

    def test_seed_must_be_labeled_and_inputs_validated(self) -> None:
        self.assertEqual(self.client.post(f"{self.base}/similar", json={**self.body, "frame": self.frames[1]}).status_code, 409)
        for bad in ({"limit": 0}, {"limit": 501}, {"method": "vgg"}):
            self.assertEqual(self.client.post(f"{self.base}/similar", json={**self.body, **bad}).status_code, 422, bad)
        with mock.patch.object(embedding, "backbones", return_value=[]):
            self.assertEqual(self.client.post(f"{self.base}/similar", json=self.body).status_code, 409)

    def test_apply_labels_only_unlabeled_live_frames(self) -> None:
        db.mark_frames_deleted(CAM, [(self.frames[3], labels.hash_map(CAM)[self.frames[3]])])
        asked = [self.frames[i] for i in (1, 2, 3, 5)]  # 3 deleted since, 5 labeled NG meanwhile
        r = self.client.post(f"{self.base}/label-frames", json={"feature": FEAT, "frames": asked, "cls": "OK"})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["labeled"], 2)
        self.assertEqual(sorted(out["skipped"]), sorted([self.frames[3], self.frames[5]]))
        lab = labels.current_labels(CAM, FEAT)
        self.assertEqual((lab[self.frames[1]], lab[self.frames[2]], lab[self.frames[5]]), ("OK", "OK", "NG"))
        self.assertNotIn(self.frames[3], lab)

    def test_apply_never_creates_goldens_or_rejects_unknown_class(self) -> None:
        self.client.post(f"{self.base}/label-frames", json={"feature": FEAT, "frames": [self.frames[1]], "cls": "OK"})
        self.assertEqual(labels.current_goldens(CAM, FEAT), {})
        bad = self.client.post(f"{self.base}/label-frames", json={"feature": FEAT, "frames": [self.frames[2]], "cls": "MAYBE"})
        self.assertEqual(bad.status_code, 422)
