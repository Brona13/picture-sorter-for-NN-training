"""Start goldens (v1.168.0): every method on synthetic embeddings, ties, the coverage curve and the endpoint. No temp files are written."""
from __future__ import annotations

import unittest
from unittest import mock

import numpy as np

import golden_start as gs
from tests.api_helpers import ApiTestCase


def unit(v: np.ndarray) -> np.ndarray:
    return (v / np.linalg.norm(v, axis=1, keepdims=True)).astype(np.float32)


def blobs(sizes=(30, 15, 8), spread=0.05, seed=1):
    """Clusters around orthogonal directions: a big, a middle and a small look."""
    rng = np.random.default_rng(seed)
    dim = 16
    rows, names = [], []
    for k, size in enumerate(sizes):
        centre = np.zeros(dim)
        centre[k] = 1.0
        rows.append(centre + rng.normal(0, spread, (size, dim)))
        names += [f"b{k}_{i:03d}.png" for i in range(size)]
    return names, unit(np.vstack(rows))


class MethodTests(unittest.TestCase):
    def setUp(self):
        self.frames, self.m = blobs()

    def group(self, frames, i):
        return int(frames[i][1])

    def test_facility_covers_every_look_biggest_first(self):
        out = gs.analyse(self.frames, self.m, set(), "facility", 3)
        looks = [self.group(self.frames, i) for i in out["picks"]]
        self.assertEqual(sorted(looks), [0, 1, 2])
        self.assertEqual(looks[0], 0)  # the first pick is the medoid, in the biggest look

    def test_facility_first_pick_is_the_medoid(self):
        a = gs.analyse(self.frames, self.m, set(), "facility", 1)["picks"]
        b = gs.analyse(self.frames, self.m, set(), "medoid", 1)["picks"]
        self.assertEqual(a, b)

    def test_medoid_is_in_the_big_look(self):
        out = gs.analyse(self.frames, self.m, set(), "medoid", 3)
        self.assertEqual(len(out["picks"]), 3)
        self.assertEqual(self.group(self.frames, out["picks"][0]), 0)

    def test_density_peaks_find_each_look(self):
        out = gs.analyse(self.frames, self.m, set(), "density", 3)
        self.assertEqual(sorted(self.group(self.frames, i) for i in out["picks"]), [0, 1, 2])

    def test_cluster_one_medoid_per_cluster_biggest_first(self):
        out = gs.analyse(self.frames, self.m, set(), "cluster", 3)
        self.assertEqual([self.group(self.frames, i) for i in out["picks"]], [0, 1, 2])

    def test_cluster_ignores_a_tiny_cluster(self):
        frames, m = blobs((60, 40, 1))
        out = gs.analyse(frames, m, set(), "cluster", 3)
        self.assertNotIn(2, [self.group(frames, i) for i in out["picks"]])

    def test_farthest_leaves_out_outliers(self):
        frames, m = blobs((40, 30, 0))
        far = np.zeros((1, m.shape[1]), dtype=np.float32)
        far[0, 9] = 1.0  # one picture alone in its own direction
        frames = frames + ["far.png"]
        m = np.vstack([m, far])
        out = gs.analyse(frames, m, set(), "farthest", 5)
        self.assertNotIn(len(frames) - 1, out["picks"])
        self.assertGreaterEqual(out["left_out"], 1)

    def test_boundary_picks_nearest_the_other_class(self):
        frames, m = blobs((20, 0, 0))
        other = unit(np.array([m[3] + m[3] * 0 + 0.0, ]))  # the other class sits on top of picture 3
        out = gs.analyse(frames, m, set(), "boundary", 2, other)
        self.assertEqual(out["picks"][0], 3)
        self.assertTrue(out["risky"])

    def test_boundary_without_other_class_gives_nothing(self):
        self.assertEqual(gs.analyse(self.frames, self.m, set(), "boundary", 2, None)["picks"], [])

    def test_goldens_are_never_picked_but_count_as_covered(self):
        first = gs.analyse(self.frames, self.m, set(), "facility", 1)["picks"][0]
        out = gs.analyse(self.frames, self.m, {self.frames[first]}, "facility", 3)
        self.assertNotIn(first, out["picks"])
        self.assertEqual(sorted(self.group(self.frames, i) for i in out["picks"][:2]), [1, 2])

    def test_unknown_method_and_tiny_class(self):
        with self.assertRaises(ValueError):
            gs.analyse(self.frames, self.m, set(), "magic", 1)
        self.assertEqual(gs.analyse(self.frames[:2], self.m[:2], set(), "facility", 1)["picks"], [])

    def test_n_is_clamped(self):
        out = gs.analyse(self.frames, self.m, set(), "medoid", 999)
        self.assertEqual(len(out["picks"]), gs.N_MAX)


class TieTests(unittest.TestCase):
    def test_identical_pictures_never_pick_by_file_order(self):
        """Distances in a narrow range are equal after rounding: the result must not follow the order of the files."""
        rng = np.random.default_rng(3)
        base = unit(rng.normal(size=(1, 16)))
        m = unit(np.repeat(base, 12, axis=0) + rng.normal(0, 1e-9, (12, 16)))
        names = [f"t{i:02d}.png" for i in range(12)]
        for method in ("facility", "medoid", "density", "farthest"):
            fwd = gs.analyse(names, m, set(), method, 3)["picks"]
            perm = np.random.default_rng(5).permutation(12)
            back = gs.analyse([names[i] for i in perm], m[perm], set(), method, 3)["picks"]
            self.assertEqual({names[i] for i in fwd}, {names[perm[i]] for i in back}, method)

    def test_narrow_range_ranks_still_spread(self):
        rng = np.random.default_rng(4)
        m = unit(np.ones((40, 16)) + rng.normal(0, 0.01, (40, 16)))
        rank = gs.rank_distance(gs.pair_distance(m))
        off = rank[np.triu_indices(40, 1)]
        self.assertGreater(off.max() - off.min(), 0.9)

    def test_rank_ties_share_a_value(self):
        d = np.array([[0, 1, 1], [1, 0, 2], [1, 2, 0]], dtype=np.float32)
        r = gs.rank_distance(d)
        self.assertEqual(r[0, 1], r[0, 2])
        self.assertLess(r[0, 1], r[1, 2])

    def test_big_class_falls_back_to_scaled_distance(self):
        with mock.patch.object(gs, "RANK_MAX", 5):
            d = gs.pair_distance(blobs((4, 4))[1])
            r = gs.rank_distance(d)
        self.assertAlmostEqual(float(r.max()), 1.0, places=5)


class CoverageTests(unittest.TestCase):
    def test_curve_grows_and_stops_after_the_looks(self):
        frames, m = blobs((30, 30, 30), spread=0.02)
        out = gs.analyse(frames, m, set(), "facility", 6)
        c = out["coverage"]
        self.assertEqual(c, sorted(c))
        self.assertEqual(out["suggested"], 3)
        self.assertGreater(c[2], 0.9)

    def test_suggested_count_edges(self):
        self.assertEqual(gs.suggested_count([]), 0)
        self.assertEqual(gs.suggested_count([0.5]), 1)
        self.assertEqual(gs.suggested_count([0.4, 0.7, 0.71, 0.9]), 2)
        self.assertEqual(gs.suggested_count([0.2, 0.5, 0.9]), 3)


class SuggestTests(unittest.TestCase):
    def setUp(self):
        self.frames, self.m = blobs((12, 12))
        self.lab = {f: ("OK" if f.startswith("b0") else "NG") for f in self.frames}

    def fake(self, camera, feature, frames, backbone):
        idx = [self.frames.index(f) for f in frames]
        return list(frames), self.m[idx]

    def test_suggest_keeps_labels_and_hides_muted(self):
        muted = {self.frames[0]}
        with mock.patch.object(gs.dedup, "fetch_embeddings", side_effect=self.fake):
            out = gs.suggest("c", "f", "OK", self.lab, {}, muted, "facility", 2, "resnet50")
        self.assertTrue(out["available"])
        self.assertEqual({p["label"] for p in out["picks"]}, {"OK"})
        self.assertEqual(out["count"], 11)
        self.assertNotIn(self.frames[0], [p["frame"] for p in out["picks"]])

    def test_no_resnet_means_nothing(self):
        out = gs.suggest("c", "f", "OK", self.lab, {}, set(), "facility", 2, None)
        self.assertFalse(out["available"])
        self.assertIsNone(out["backbone"])

    def test_boundary_fetches_the_other_class(self):
        with mock.patch.object(gs.dedup, "fetch_embeddings", side_effect=self.fake) as f:
            out = gs.suggest("c", "f", "OK", self.lab, {}, set(), "boundary", 2, "resnet50")
        self.assertEqual(f.call_count, 2)
        self.assertTrue(out["risky"])


if __name__ == "__main__":
    unittest.main()


class EndpointTests(ApiTestCase):
    """The route only validates and hands the labels to ``golden_start.suggest``; the classifier's data is mocked, nothing is stored."""

    def setUp(self):
        super().setUp()  # temp config dirs and a client
        self.url = "/api/cameras/camA/classify/start-goldens"

    def patches(self, **extra):
        import datamodel
        import labels
        from api import classify_api as api

        ps = [
            mock.patch.object(api, "require_feature"),
            mock.patch.object(datamodel, "classes_for", return_value=["OK", "NG"]),
            mock.patch.object(labels, "current_labels", return_value={"a.png": "OK"}),
            mock.patch.object(labels, "current_goldens", return_value={}),
            mock.patch.object(api.db, "muted_frames", return_value=set()),
            mock.patch.object(api.suggest_goldens_mod, "_diversity_backbone", return_value="resnet50"),
            mock.patch.object(api.golden_start, "suggest", return_value={"available": True, "picks": [], **extra}),
        ]
        return ps

    def call(self, **params):
        from contextlib import ExitStack

        with ExitStack() as st:
            mocks = [st.enter_context(p) for p in self.patches()]
            r = self.client.get(self.url, params={"feature": "seal", "cls": "OK", **params})
        return r, mocks[-1]

    def test_ok_passes_class_method_and_count(self):
        r, suggest = self.call(method="density", n=4)
        self.assertEqual(r.status_code, 200)
        args = suggest.call_args.args
        self.assertEqual((args[2], args[6], args[7], args[8]), ("OK", "density", 4, "resnet50"))

    def test_bad_inputs_are_422(self):
        self.assertEqual(self.call(method="magic")[0].status_code, 422)
        self.assertEqual(self.call(n=0)[0].status_code, 422)
        self.assertEqual(self.call(n=gs.N_MAX + 1)[0].status_code, 422)
        self.assertEqual(self.call(cls="maybe")[0].status_code, 422)
