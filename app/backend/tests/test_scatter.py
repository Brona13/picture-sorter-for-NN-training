from __future__ import annotations

import importlib.util
import threading
import unittest
from unittest import mock

import numpy as np

import scatter

HAS_UMAP = importlib.util.find_spec("umap") is not None and importlib.util.find_spec("sklearn") is not None


def blobs(n: int, dim: int, k: int = 4, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(k, dim))[rng.integers(0, k, n)] + rng.normal(scale=0.3, size=(n, dim))
    return (x / np.linalg.norm(x, axis=1, keepdims=True)).astype(np.float32)


@unittest.skipUnless(HAS_UMAP, "umap-learn / scikit-learn not installed")
class UmapProjectionTests(unittest.TestCase):
    def test_projection_shape_and_finite(self) -> None:
        xy = scatter._umap(blobs(120, 128))
        self.assertEqual(xy.shape, (120, 2))
        self.assertTrue(np.isfinite(xy).all())

    def test_layout_keeps_neighbourhoods(self) -> None:
        from sklearn.manifold import trustworthiness  # noqa: PLC0415

        x = blobs(150, 128, k=3)
        self.assertGreater(trustworthiness(x, scatter._umap(x), n_neighbors=5, metric="cosine"), 0.9)

    def test_large_sets_use_fewer_epochs_and_forced_nn_descent(self) -> None:
        with mock.patch.object(scatter, "_umap_with", return_value=np.zeros((3, 2), np.float32)) as m:
            scatter._umap(np.zeros((scatter.EPOCHS_FULL_BELOW, 8), np.float32))
            scatter._umap(np.zeros((scatter.EPOCHS_FULL_BELOW - 1, 8), np.float32))
        big, small = m.call_args_list
        self.assertEqual(big.kwargs["epochs"], scatter.EPOCHS_LARGE)
        self.assertIsNone(small.kwargs["epochs"])
        self.assertTrue(big.kwargs["approx"] and small.kwargs["approx"])


class PrewarmTests(unittest.TestCase):
    def test_prewarm_runs_once_in_the_background(self) -> None:
        done = threading.Event()
        with (
            mock.patch.object(scatter, "_warm_started", False),
            mock.patch.object(scatter, "_umap", side_effect=lambda m: done.set()) as um,
        ):
            scatter.prewarm()
            scatter.prewarm()
            self.assertTrue(done.wait(5))
            self.assertEqual(um.call_count, 1)

    def test_prewarm_swallows_missing_dependency(self) -> None:
        with (
            mock.patch.object(scatter, "_warm_started", False),
            mock.patch.object(scatter, "_umap", side_effect=ImportError("umap")),
        ):
            scatter.prewarm()
            for t in threading.enumerate():
                if t.name == "scatter-prewarm":
                    t.join(5)
