from __future__ import annotations

import unittest
from unittest import mock

import numpy as np

import classify
import classify_view as cv
import config
import insights
import suggest_goldens
from tests.api_helpers import ApiTestCase
from tests.test_api_classify import CAM, FEAT, write_two_groups
from tests.test_classify_view import A, B, C, G, fs
import datamodel
import db
import flow
import labels
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
        # the matrix is made for ResNet50 only; these tests have no torch, so they run it on the classical method
        self._matrix_method = mock.patch.object(cv, "MATRIX_METHOD", "cpu")
        self._matrix_method.start()
        self.blue, self.red = write_two_groups(CAM)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        self.base = f"/api/cameras/{CAM}"

    def tearDown(self) -> None:
        self._matrix_method.stop()
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

    def test_center_follows_the_view_filter(self) -> None:
        for f in self.blue:
            self.label(f, "OK")
        for f in self.red:
            self.label(f, "NG")
        self.refresh()
        red = set(self.red)

        def fetch(camera, feature, frames, backbone):  # blue pictures near angle 0, red near 90 degrees
            rng = np.random.default_rng(1)
            rad = np.deg2rad([(90.0 if f in red else 0.0) + rng.normal(0, 1.0) for f in frames])
            return list(frames), np.stack([np.cos(rad), np.sin(rad)], axis=1).astype(np.float32)

        q = {"feature": FEAT, "rank": "cpu"}
        with mock.patch.object(suggest_goldens, "_diversity_backbone", return_value="resnet18"), \
                mock.patch.object(suggest_goldens.dedup, "fetch_embeddings", side_effect=fetch):
            ok = self.client.get(f"{self.base}/classify/center", params={**q, "view": "Labeled OK", "n": 1}).json()
            ng = self.client.get(f"{self.base}/classify/center", params={**q, "view": "Labeled NG", "n": 1}).json()
            everything = self.client.get(f"{self.base}/classify/center", params={**q, "n": 2}).json()
            self.assertEqual(self.client.get(f"{self.base}/classify/center", params={**q, "n": 99}).status_code, 422)
        self.assertTrue(ok["available"])
        self.assertEqual((ok["view"], ok["count"], ok["picks"][0]["label"]), ("Labeled OK", len(self.blue), "OK"))
        self.assertIn(ok["picks"][0]["frame"], self.blue)
        self.assertEqual((ng["picks"][0]["label"], ng["count"]), ("NG", len(self.red)))
        self.assertIn(ng["picks"][0]["frame"], self.red)
        self.assertEqual({p["label"] for p in everything["picks"]}, {"OK", "NG"})  # no filter: the center of each look

    def test_center_needs_a_resnet(self) -> None:
        with mock.patch.object(suggest_goldens, "_diversity_backbone", return_value=None):
            body = self.client.get(f"{self.base}/classify/center", params={"feature": FEAT, "rank": "cpu"}).json()
        self.assertEqual((body["available"], body["picks"], body["backbone"]), (False, [], None))

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

        # each cell names its Show entry; a Classifier in step 2 offers it, and the grid lists exactly the cell's frames
        views = cpu["views"]
        self.assertEqual(views["OK"]["NG"], "CPU · False negative (labeled OK, model says NG)")
        self.assertEqual(views["NG"]["OK"], "CPU · False positive (labeled NG, model says OK)")
        self.assertEqual(views["OK"]["OK"], "CPU · True positive (labeled OK, model says OK)")
        self.assertEqual(views["NG"]["NG"], "CPU · True negative (labeled NG, model says NG)")
        grid = lambda view: self.client.get(f"{self.base}/classify/grid", params={"feature": FEAT, "rank": "cpu", "view": view})
        self.assertEqual(grid(views["OK"]["OK"]).status_code, 422)  # step 1: no goldens are marked, so the cells are not offered
        self.assertNotIn(views["OK"]["OK"], self.client.get(f"{self.base}/classify/state", params={"feature": FEAT}).json()["views"])
        flow.set_roi_step(CAM, FEAT, 2)
        self.assertIn(views["OK"]["OK"], self.client.get(f"{self.base}/classify/state", params={"feature": FEAT}).json()["views"])
        tp = grid(views["OK"]["OK"]).json()
        self.assertEqual(sorted(c["frame"] for c in tp["items"]), sorted(self.blue[1:]))
        self.assertEqual({c["label"] for c in tp["items"]}, {"OK"})
        self.assertEqual(grid(views["OK"]["NG"]).json()["items"], [])  # no false negatives here

        # a label the method gets wrong shows up under the right name
        self.label(self.red[1], "OK")  # labeled OK, but it looks like the NG group
        self.refresh()
        fn = grid(views["OK"]["NG"]).json()
        self.assertEqual([c["frame"] for c in fn["items"]], [self.red[1]])
        body = self.client.get(url, params={"feature": FEAT}).json()
        self.assertEqual(body["matrices"]["cpu"]["matrix"]["OK"]["NG"], 1)

    def test_the_matrix_is_made_for_resnet50_only_and_says_so_when_it_is_off(self) -> None:
        self._matrix_method.stop()  # the real setting: ResNet50, which is not in use here (no torch, classical method only)
        try:
            self.label(self.blue[0], "OK", golden=True)
            self.label(self.red[0], "NG", golden=True)
            body = self.client.get(f"{self.base}/insights", params={"feature": FEAT}).json()
            self.assertEqual((body["reason"], body["methods"], body["matrices"]), ("method_off", [], {}))
            flow.set_roi_step(CAM, FEAT, 2)
            views = self.client.get(f"{self.base}/classify/state", params={"feature": FEAT}).json()["views"]
            self.assertFalse([v for v in views if "model says" in v])
        finally:
            self._matrix_method.start()

    def test_insights_leaves_out_pictures_muted_in_this_classifier(self) -> None:
        self.label(self.blue[0], "OK", golden=True)
        self.label(self.red[0], "NG", golden=True)
        for b in self.blue[1:]:
            self.label(b, "OK")
        for r in self.red[1:]:
            self.label(r, "NG")
        self.refresh()
        url = f"{self.base}/insights"
        self.assertEqual(self.client.get(url, params={"feature": FEAT}).json()["evaluable"], 6)
        db.add_dedup_mutes(CAM, FEAT, [(self.blue[1], labels.frame_hash(CAM, self.blue[1]), 1)])
        body = self.client.get(url, params={"feature": FEAT}).json()
        self.assertEqual((body["evaluable"], body["matrices"]["cpu"]["total"]), (5, 5))

    def test_the_old_cell_list_endpoint_is_gone(self) -> None:
        r = self.client.get(f"{self.base}/insights/cell", params={"feature": FEAT, "method": "cpu", "true_cls": "OK", "pred_cls": "OK"})
        self.assertEqual(r.status_code, 404)


class CenterTests(unittest.TestCase):
    """Density peaks in the embedding (v1.157.0)."""

    def vectors(self, groups, step=0.2):
        """Unit vectors on a circle: ``groups`` = [(frame prefix, centre angle in degrees, count)], ``step`` degrees apart."""
        frames, rows = [], []
        for prefix, angle, count in groups:
            for i in range(count):
                a = np.deg2rad(angle + (i - (count - 1) / 2) * step)
                frames.append(f"{prefix}{i}")
                rows.append([np.cos(a), np.sin(a)])
        return frames, np.array(rows, dtype=np.float32)

    def run_center(self, frames, matrix, n=3, gold=None):
        items = [fs(f) for f in frames]
        with mock.patch.object(suggest_goldens.dedup, "fetch_embeddings", return_value=(list(frames), matrix)):
            return suggest_goldens.center(camera="c", feature="f", items=items, n=n, gold=gold or {}, diversity_backbone="resnet18")

    def test_the_pick_is_in_the_middle_of_the_crowd_not_of_the_outliers(self) -> None:
        angles = np.random.default_rng(3).normal(0.0, 2.0, 40)  # a crowd that is dense in the middle and thin at the sides
        frames = [f"m{i}" for i in range(40)] + ["far1", "far2"]
        rad = np.deg2rad(np.concatenate([angles, [90.0, 80.0]]))  # two outliers on one side would pull an average that way
        matrix = np.stack([np.cos(rad), np.sin(rad)], axis=1).astype(np.float32)
        out = self.run_center(frames, matrix, n=1)
        picked = angles[int(out[0].frame[1:])]
        self.assertTrue(out[0].frame.startswith("m"))
        self.assertLess(abs(picked - np.median(angles)), 1.0)  # within a degree of the middle of the crowd

    def test_each_further_pick_is_the_peak_of_another_look(self) -> None:
        frames, matrix = self.vectors([("a", 0, 30), ("b", 90, 12), ("c", 180, 6)])
        out = self.run_center(frames, matrix, n=3)
        self.assertEqual(sorted(r.frame[0] for r in out), ["a", "b", "c"])  # one per look, not three from the biggest
        self.assertEqual(out[0].frame[0], "a")  # the main crowd first

    def test_a_golden_is_not_picked_but_still_counts_in_the_crowd(self) -> None:
        frames, matrix = self.vectors([("a", 0, 21)])
        first = self.run_center(frames, matrix, n=1)[0].frame
        again = self.run_center(frames, matrix, n=2, gold={"OK": [first]})
        self.assertNotIn(first, [r.frame for r in again])
        self.assertTrue(again)

    def test_too_few_pictures_or_no_resnet_give_nothing(self) -> None:
        frames, matrix = self.vectors([("a", 0, 2)])
        self.assertEqual(self.run_center(frames, matrix), [])
        with mock.patch.object(suggest_goldens, "_diversity_backbone", return_value=None):
            self.assertEqual(suggest_goldens.center(camera="c", feature="f", items=[fs("a"), fs("b"), fs("c")], gold={}), [])

    def test_density_is_high_where_pictures_are_close(self) -> None:
        frames, matrix = self.vectors([("a", 0, 10)])
        matrix = np.vstack([matrix, [[0, 1]]]).astype(np.float32)
        dens = suggest_goldens.density(matrix, 3)
        self.assertLess(float(dens[-1]), float(dens[:-1].min()))

    def test_a_small_tight_group_does_not_outrank_the_main_crowd(self) -> None:
        frames, matrix = self.vectors([("big", 0, 40)], step=0.5)
        f2, m2 = self.vectors([("tiny", 120, 4)], step=0.01)  # four almost identical pictures
        out = self.run_center(frames + f2, np.vstack([matrix, m2]).astype(np.float32), n=1)
        self.assertTrue(out[0].frame.startswith("big"))
