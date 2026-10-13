from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np



import embedding
import perf

try:
    import torch
except ImportError:  # pragma: no cover - exercised only without optional dependency
    torch = None


@unittest.skipIf(torch is None, "torch is an optional dependency")
class EmbeddingBatchTests(unittest.TestCase):
    @staticmethod
    def _preprocess(image):
        array = np.asarray(image).copy()
        return torch.from_numpy(array).permute(2, 0, 1).float() / 255.0

    @staticmethod
    def _images(count: int) -> list[np.ndarray]:
        return [
            np.full((12, 10, 3), (20 + i * 17, 60 + i * 11, 120 + i * 7), np.uint8)
            for i in range(count)
        ]

    def test_batch_matches_single_image_and_preserves_order_and_norm(self):
        class TinyModel:
            def __init__(self):
                self.calls = []

            def __call__(self, batch):
                self.calls.append(int(batch.shape[0]))
                means = batch.mean(dim=(2, 3))
                return torch.cat((means, means[:, :1] * 0.5 + 0.25), dim=1)

        model = TinyModel()
        images = self._images(5)
        with (
            patch.object(embedding, "_torch", torch),
            patch("embedding.get_model", return_value=(model, self._preprocess)),
            patch("embedding.active_device", return_value="cpu"),
        ):
            batched = embedding.embed_batch(images, "test-backbone", batch_size=2)
            singles = [embedding.embed(image, "test-backbone") for image in images]

        self.assertEqual([2, 2, 1, 1, 1, 1, 1, 1], model.calls)
        np.testing.assert_allclose(np.stack(batched), np.stack(singles), atol=1e-6)
        np.testing.assert_allclose(
            np.linalg.norm(np.stack(batched), axis=1), np.ones(5), atol=1e-6
        )

    def test_runtime_failure_retries_with_smaller_batches(self):
        class CapacityLimitedModel:
            def __init__(self):
                self.calls = []

            def __call__(self, batch):
                size = int(batch.shape[0])
                self.calls.append(size)
                if size > 2:
                    raise RuntimeError("synthetic capacity limit")
                means = batch.mean(dim=(2, 3))
                return torch.cat((means, means[:, :1] + 0.1), dim=1)

        model = CapacityLimitedModel()
        with (
            patch.object(embedding, "_torch", torch),
            patch("embedding.get_model", return_value=(model, self._preprocess)),
            patch("embedding.active_device", return_value="cpu"),
            perf.trace("batch-retry-test", enabled=True, emit=False) as report,
        ):
            vectors = embedding.embed_batch(
                self._images(4), "test-backbone", batch_size=4
            )

        self.assertEqual([4, 2, 2], model.calls)
        self.assertEqual(4, len(vectors))
        self.assertEqual(1, report.counters["embedding.test-backbone.batch_retries"])


if __name__ == "__main__":
    unittest.main()
