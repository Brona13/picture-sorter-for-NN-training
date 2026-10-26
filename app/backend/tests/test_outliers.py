from __future__ import annotations

from unittest import mock

import numpy as np

import datamodel
import db
import dedup
import flow
import embedding
import labels
import outliers
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job, write_frames

CAM, ROI_NAME, FEAT = "camA", "seal", "dedup:1"  # the Dedup box and the Classifier it reads


class KnnScoreTests(ApiTestCase):
    def test_isolated_row_scores_highest(self) -> None:
        m = np.array([[1, 0, 0], [1, 0.01, 0], [1, 0, 0.01], [0, 0, 1]], dtype=np.float32)
        scores = outliers.knn_scores(m, k=2)
        self.assertEqual(int(np.argmax(scores)), 3)
        self.assertLess(float(scores[:3].max()), float(scores[3]))

    def test_identical_rows_score_zero_and_self_is_excluded(self) -> None:
        m = np.array([[1, 0], [1, 0], [1, 0]], dtype=np.float32)
        np.testing.assert_allclose(outliers.knn_scores(m, k=2), 0.0, atol=1e-6)

    def test_k_is_clamped_and_tiny_inputs_are_safe(self) -> None:
        self.assertEqual(outliers.knn_scores(np.zeros((0, 3), dtype=np.float32), 5).shape, (0,))
        self.assertEqual(outliers.knn_scores(np.array([[1.0, 0.0]], dtype=np.float32), 5).tolist(), [0.0])
        two = outliers.knn_scores(np.array([[1, 0], [0, 1]], dtype=np.float32), k=20)
        np.testing.assert_allclose(two, 1.0, atol=1e-6)

    def test_chunked_result_matches_unchunked(self) -> None:
        rng = np.random.default_rng(3)
        m = rng.normal(size=(40, 8)).astype(np.float32)
        full = outliers.knn_scores(m, k=3)
        with mock.patch.object(outliers, "_CHUNK", 7):
            np.testing.assert_allclose(outliers.knn_scores(m, k=3), full, atol=1e-6)

    def test_rank_orders_descending_with_stable_ties(self) -> None:
        ranked = outliers.rank(["a", "b", "c"], np.array([0.1, 0.3, 0.3], dtype=np.float32))
        self.assertEqual([f for f, _ in ranked], ["b", "c", "a"])


class OutlierApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 6)
        datamodel.save_rois(CAM, [ROI(name=ROI_NAME, x=0, y=0, w=1, h=1)])
        flow.connect(CAM, "ingest", flow.create_node(CAM, "dedup"))  # v1.107.0: a box with no line has no pictures
        vecs = {0: [1, 0, 0], 1: [1, 0.001, 0], 2: [1, 0, 0.001], 3: [1, 0.002, 0], 4: [1, 0, 0.002], 5: [0, 0, 1]}

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
        self.url = f"/api/cameras/{CAM}/dedup/outliers"
        self.body = {"feature": FEAT, "method": "resnet50", "k": 3}

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()
        super().tearDown()

    def run_job(self, **over):
        r = self.client.post(self.url, json={**self.body, **over})
        self.assertEqual(r.status_code, 202, r.text)
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        return job["result"]

    def test_most_isolated_frame_is_first(self) -> None:
        res = self.run_job()
        self.assertEqual(res["scores"][0]["frame"], self.frames[5])
        self.assertEqual(len(res["scores"]), 6)
        scores = [s["score"] for s in res["scores"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertEqual(res["summary"]["max"], scores[0])
        self.assertEqual((res["method"], res["k"]), ("resnet50", 3))

    def test_marks_and_deleted_frames(self) -> None:
        for f in self.frames:
            labels.set_label(CAM, ROI_NAME, f, "OK")
        labels.set_label(CAM, ROI_NAME, self.frames[5], "NG")
        flow.update_node(CAM, FEAT, {"source": {"feature": ROI_NAME, "dot": "all"}})
        db.mark_frames_deleted(CAM, [(self.frames[0], labels.hash_map(CAM)[self.frames[0]])])
        res = self.run_job()
        self.assertEqual(res["marks"][self.frames[5]]["label"], "NG")
        self.assertNotIn(self.frames[0], [s["frame"] for s in res["scores"]])
        self.assertEqual(len(res["scores"]), 5)

    def test_validation(self) -> None:
        for bad in ({"k": 0}, {"k": 21}, {"method": "vgg"}):
            self.assertEqual(self.client.post(self.url, json={**self.body, **bad}).status_code, 422, bad)
        with mock.patch.object(embedding, "backbones", return_value=[]):
            self.assertEqual(self.client.post(self.url, json=self.body).status_code, 409)
