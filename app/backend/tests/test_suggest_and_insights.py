from __future__ import annotations

import unittest
from unittest import mock

import numpy as np

import classify
import config
import insights
import suggest_goldens
from tests.api_helpers import ApiTestCase
from tests.test_api_classify import CAM, FEAT, write_two_groups
from tests.test_classify_view import A, B, C, G, fs
import datamodel
from roi import ROI


def scored(frame, margin, leaning="OK"):
    return fs(frame, cpu={"dists": {"OK": 0.1, "NG": 0.1 + margin}, "leaning": leaning, "margin": margin, "novelty": 0.1})


class SuggestTests(unittest.TestCase):
    def pick(self, items, n, **kw):
        with mock.patch.object(suggest_goldens.dedup, "fetch_embeddings") as fe:
            fe.side_effect = kw.get("fetch")
            return suggest_goldens.suggest(
                camera="c", feature="f", items=items, rank_method="cpu", n=n, lab=kw.get("lab", {}),
                gold=kw.get("gold", {}), diversity_backbone=kw.get("backbone"),
            )

    def test_without_embeddings_takes_smallest_margins(self) -> None:
        items = [scored("a", 0.5), scored("b", 0.01), scored("c", 0.2), scored("d", 0.05)]
        with mock.patch.object(suggest_goldens, "_diversity_backbone", return_value=None):
            out = suggest_goldens.suggest(camera="c", feature="f", items=items, rank_method="cpu", n=2, lab={}, gold={})
        self.assertEqual([r.frame for r in out], ["b", "d"])

    def test_excludes_labeled_goldens_and_unscored(self) -> None:
        items = [scored("a", 0.5), scored("b", 0.01), scored("g", 0.02), fs("u")]
        with mock.patch.object(suggest_goldens, "_diversity_backbone", return_value=None):
            out = suggest_goldens.suggest(
                camera="c", feature="f", items=items, rank_method="cpu", n=5,
                lab={"b": "OK", "g": "OK"}, gold={"OK": ["g"]},
            )
        self.assertEqual([r.frame for r in out], ["a"])

    def test_diversity_skips_near_duplicates_of_the_first_pick(self) -> None:
        items = [scored("a", 0.01), scored("b", 0.02), scored("c", 0.03), scored("d", 0.04)]
        vecs = {"a": [1, 0], "b": [1, 0.01], "c": [0, 1], "d": [-1, 0]}  # b ~ a; c orthogonal; d opposite

        def fetch(camera, feature, frames, backbone):
            m = np.array([vecs[f] for f in frames], dtype=np.float32)
            m /= np.linalg.norm(m, axis=1, keepdims=True)
            return list(frames), m

        out = self.pick(items, 2, backbone="resnet50", fetch=fetch)
        # first = shakiest ("a"); second = farthest from it ("d"), not its twin "b"
        self.assertEqual([r.frame for r in out], ["a", "d"])

    def test_no_candidates(self) -> None:
        self.assertEqual(self.pick([fs("u")], 3), [])


class InsightsTests(unittest.TestCase):
    def test_matrix_counts_and_skips(self) -> None:
        results = [A, B, C, fs("d.png", cpu={"dists": {"OK": 0.1}, "leaning": None, "margin": None, "novelty": 0.1})]
        evaluable = {"a.png": "OK", "b.png": "NG", "c.png": "NG", "d.png": "OK", "zz.png": "OK"}
        matrix, skipped = insights.build_matrix(results, evaluable, ["OK", "NG"], "cpu")
        self.assertEqual(matrix, {"OK": {"OK": 1, "NG": 0}, "NG": {"OK": 1, "NG": 1}})
        self.assertEqual(skipped, 1)
        s = insights.summarize(matrix, ["OK", "NG"])
        self.assertEqual((s["correct"], s["total"]), (2, 3))
        self.assertAlmostEqual(s["accuracy"], 66.666, places=2)
        self.assertEqual(insights.summarize({"OK": {"OK": 0}}, ["OK"])["accuracy"], 0.0)

    def test_cell_frames_match_matrix_cells(self) -> None:
        results = [A, B, C, fs("d.png", cpu={"dists": {"OK": 0.1}, "leaning": None, "margin": None, "novelty": 0.1})]
        evaluable = {"a.png": "OK", "b.png": "NG", "c.png": "NG", "d.png": "OK", "zz.png": "OK"}
        matrix, _ = insights.build_matrix(results, evaluable, ["OK", "NG"], "cpu")
        for t in ("OK", "NG"):
            for p in ("OK", "NG"):
                self.assertEqual(len(insights.cell_frames(results, evaluable, "cpu", t, p)), matrix[t][p])
        self.assertEqual(insights.cell_frames(results, evaluable, "cpu", "OK", "NG"), [])

    def test_goldens_are_excluded_from_evaluation(self) -> None:
        ev = insights.evaluable_labels({"a": "OK", "g": "OK"}, {"OK": ["g"]})
        self.assertEqual(ev, {"a": "OK"})


class SuggestInsightsApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._emb = config.EMBEDDING_ENABLED
        config.EMBEDDING_ENABLED = False
        self.blue, self.red = write_two_groups(CAM)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        self.base = f"/api/cameras/{CAM}"

    def tearDown(self) -> None:
        config.EMBEDDING_ENABLED = self._emb
        super().tearDown()

    def label(self, frame, cls, golden=False):
        self.client.put(f"{self.base}/classify/label", json={"feature": FEAT, "frame": frame, "cls": cls})
        if golden:
            self.client.put(f"{self.base}/classify/golden", json={"feature": FEAT, "frame": frame, "golden": True})

    def refresh(self):
        from tests.api_helpers import wait_for_job

        r = self.client.post(f"{self.base}/classify/refresh", json={"feature": FEAT})
        wait_for_job(self.client, r.json()["id"], timeout=60)

    def test_suggest_unavailable_until_two_golden_classes_and_scores(self) -> None:
        q = {"feature": FEAT, "rank": "cpu"}
        self.assertFalse(self.client.get(f"{self.base}/classify/suggest", params=q).json()["available"])
        self.label(self.blue[0], "OK", golden=True)
        self.refresh()
        self.assertFalse(self.client.get(f"{self.base}/classify/suggest", params=q).json()["available"])

    def test_suggest_then_promote(self) -> None:
        q = {"feature": FEAT, "rank": "cpu"}
        self.label(self.blue[0], "OK", golden=True)
        self.label(self.red[0], "NG", golden=True)
        self.refresh()
        body = self.client.get(f"{self.base}/classify/suggest", params={**q, "n": 3}).json()
        self.assertTrue(body["available"])
        self.assertEqual(len(body["picks"]), 3)
        margins = [p["bars"]["margin"] for p in body["picks"]]
        self.assertEqual(margins, sorted(margins))  # most uncertain first (no embeddings -> by margin)
        self.assertEqual(self.client.get(f"{self.base}/classify/suggest", params={**q, "n": 1}).status_code, 422)

        frame = body["picks"][0]["frame"]
        r = self.client.post(f"{self.base}/classify/promote", json={"feature": FEAT, "frame": frame, "cls": "OK"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["card"]["label"], r.json()["card"]["golden"]), ("OK", "OK"))
        again = self.client.get(f"{self.base}/classify/suggest", params={**q, "n": 3}).json()
        self.assertNotIn(frame, [p["frame"] for p in again["picks"]])
        bad = self.client.post(f"{self.base}/classify/promote", json={"feature": FEAT, "frame": frame, "cls": "XX"})
        self.assertEqual(bad.status_code, 422)

    def test_insights_reasons_and_matrices(self) -> None:
        url = f"{self.base}/insights"
        self.assertEqual(self.client.get(url, params={"feature": FEAT}).json()["reason"], "needs_two_golden_classes")
        self.label(self.blue[0], "OK", golden=True)
        self.label(self.red[0], "NG", golden=True)
        self.assertEqual(self.client.get(url, params={"feature": FEAT}).json()["reason"], "no_held_out_labels")

        for b in self.blue[1:]:
            self.label(b, "OK")
        for r in self.red[1:]:
            self.label(r, "NG")
        body = self.client.get(url, params={"feature": FEAT}).json()
        self.assertIsNone(body["reason"])
        self.assertFalse(body["has_results"])
        self.assertEqual(body["evaluable"], 6)

        self.refresh()
        body = self.client.get(url, params={"feature": FEAT}).json()
        self.assertTrue(body["has_results"])
        cpu = body["matrices"]["cpu"]
        self.assertEqual(cpu["total"], 6)
        self.assertEqual(cpu["correct"], 6)  # well-separated synthetic groups
        self.assertEqual(cpu["matrix"], {"OK": {"OK": 3, "NG": 0}, "NG": {"OK": 0, "NG": 3}})
        self.assertEqual(cpu["accuracy"], 100.0)

        cell = self.client.get(f"{url}/cell", params={"feature": FEAT, "method": "cpu", "true_cls": "OK", "pred_cls": "OK"}).json()
        self.assertEqual(sorted(c["frame"] for c in cell["items"]), sorted(self.blue[1:]))
        self.assertEqual({c["label"] for c in cell["items"]}, {"OK"})
        self.assertIn("bars", cell["items"][0])
        self.assertEqual(cell["classes"], ["OK", "NG"])
        empty = self.client.get(f"{url}/cell", params={"feature": FEAT, "method": "cpu", "true_cls": "OK", "pred_cls": "NG"}).json()
        self.assertEqual(empty["items"], [])
        self.assertEqual(self.client.get(f"{url}/cell", params={"feature": FEAT, "method": "x", "true_cls": "OK", "pred_cls": "OK"}).status_code, 422)
