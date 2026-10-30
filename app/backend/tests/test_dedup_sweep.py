from __future__ import annotations

import unittest

import numpy as np

import dedup


class SweepHelpersTests(unittest.TestCase):
    def test_epsilons_are_inclusive_and_rounded(self) -> None:
        self.assertEqual(dedup.sweep_epsilons(0.005, 0.03, 0.005), [0.005, 0.01, 0.015, 0.02, 0.025, 0.03])
        self.assertEqual(dedup.sweep_epsilons(0.01, 0.0105, 0.005), [0.01])

    def test_window_runs_from_first_mute_to_the_single_cluster(self) -> None:
        self.assertEqual(dedup.window_of([0, 0, 2, 5, 3, 1, 1], [0, 0, 2, 6, 9, 20, 20]), (2, 5))
        self.assertEqual(dedup.window_of([0, 2, 3, 4], [0, 1, 2, 3]), (1, 3))  # never reaches one cluster: to the end
        self.assertIsNone(dedup.window_of([0, 0, 0], [0, 0, 0]))
        # a single cluster right where the muting starts is the foot of the hill, not its end
        self.assertEqual(dedup.window_of([0, 1, 3, 5, 2, 1, 1], [0, 1, 3, 6, 9, 20, 20]), (1, 5))

    def test_peak_prefers_smaller_epsilon_then_smaller_min_points(self) -> None:
        lines = {2: {"clusters": [1, 5, 5, 2], "would_mute": [1, 5, 5, 9]}, 3: {"clusters": [None, 5, 4, 1], "would_mute": [None, 5, 4, 9]}}
        self.assertEqual(dedup.peak_of(lines, [0.01, 0.02, 0.03, 0.04]), {"epsilon": 0.02, "min_points": 2, "clusters": 5})
        self.assertIsNone(dedup.peak_of({2: {"clusters": [0, 0], "would_mute": [0, 0]}}, [0.01, 0.02]))


class SweepMatrixTests(unittest.TestCase):
    def matrix(self) -> np.ndarray:
        # groups of 3 and 2 near-identical vectors and one loner
        v = [[1, 0, 0], [1, 0.001, 0], [1, 0, 0.001], [0, 1, 0], [0, 1, 0.001], [0, 0, 1]]
        m = np.array(v, dtype=np.float32)
        return m / np.linalg.norm(m, axis=1, keepdims=True)

    def test_counts_match_dbscan_and_other_min_points_run_only_in_the_window(self) -> None:
        eps = [1e-8, 0.001, 0.01, 1.5]
        seen = []
        out = dedup.sweep_matrix(self.matrix(), epsilons=eps, min_points=[3, 2], progress_cb=lambda d, t: seen.append((d, t)))
        self.assertEqual(out["min_points"], [2, 3])
        two, three = out["lines"][2], out["lines"][3]
        self.assertEqual(two["clusters"][0], 0)
        self.assertEqual(two["clusters"][2], 2)
        self.assertEqual(two["would_mute"][2], 3)
        self.assertEqual(two["clusters"][3], 1)  # everything chains into one cluster
        self.assertEqual(out["window"], {"from": 0.001, "to": 1.5})
        self.assertIsNone(three["clusters"][0])  # before the window
        self.assertEqual(three["clusters"][1], 1)  # only the group of 3 has 3 close neighbours
        self.assertEqual(out["peak"]["clusters"], 2)
        self.assertEqual(seen[-1][0], seen[-1][1])

    def test_a_box_where_nothing_clusters_has_no_window_and_no_peak(self) -> None:
        out = dedup.sweep_matrix(np.eye(4, dtype=np.float32), epsilons=[0.01, 0.02], min_points=[2, 3])
        self.assertIsNone(out["window"])
        self.assertIsNone(out["peak"])
        self.assertEqual(out["lines"][3]["clusters"], [None, None])

    def test_empty_matrix(self) -> None:
        out = dedup.sweep_matrix(np.zeros((0, 3), dtype=np.float32), epsilons=[0.01], min_points=[2])
        self.assertEqual(out["frames"], 0)
