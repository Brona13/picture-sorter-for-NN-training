from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import cv2
import numpy as np


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import classify
import config
import db
import dedup
import perf
from roi import ROI


class FeatureCacheBatchingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        self.old_query_size = config.FEATURE_CACHE_QUERY_BATCH_SIZE
        self.old_write_size = config.FEATURE_CACHE_WRITE_BATCH_SIZE
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"
        config.FEATURE_CACHE_QUERY_BATCH_SIZE = 400
        config.FEATURE_CACHE_WRITE_BATCH_SIZE = 128
        self.camera = "camera"
        self.feature = "feature"
        self.frames = [f"frame-{i:02d}.png" for i in range(10)]
        unsorted = config.CAMERAS_ROOT / self.camera / "unsorted"
        unsorted.mkdir(parents=True)
        for i, frame in enumerate(self.frames):
            image = np.full((32, 40, 3), (i * 13, 80, 200 - i), np.uint8)
            self.assertTrue(cv2.imwrite(str(unsorted / frame), image))
        self.hmap = {frame: f"hash-{i:02d}" for i, frame in enumerate(self.frames)}

    def tearDown(self):
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        config.FEATURE_CACHE_QUERY_BATCH_SIZE = self.old_query_size
        config.FEATURE_CACHE_WRITE_BATCH_SIZE = self.old_write_size
        self.tmp.cleanup()

    def test_cold_and_warm_classical_fetch_use_bounded_bulk_operations(self):
        roi = ROI.full_frame(self.feature)
        progress = []
        con = db.connect()
        try:
            with perf.trace("cold-cache", enabled=True, emit=False) as cold:
                cold_vectors = classify.fetch_vectors(
                    con, self.camera, self.feature, classify._roi_cache_key(roi),
                    roi, self.frames, self.hmap, [], progress_cb=lambda d, t: progress.append((d, t)),
                )
            with perf.trace("warm-cache", enabled=True, emit=False) as warm:
                warm_vectors = classify.fetch_vectors(
                    con, self.camera, self.feature, classify._roi_cache_key(roi),
                    roi, self.frames, self.hmap, [],
                )
            row_count = con.execute("SELECT COUNT(*) FROM score_cache").fetchone()[0]
        finally:
            con.close()

        self.assertEqual(20, row_count)
        self.assertEqual(1, cold.counters["score_cache.bulk_queries"])
        self.assertEqual(1, cold.counters["score_cache.write_batches"])
        self.assertEqual(20, cold.counters["score_cache.rows_written"])
        self.assertEqual([(i, 10) for i in range(1, 11)], progress)
        self.assertEqual(1, warm.counters["score_cache.bulk_queries"])
        self.assertNotIn("score_cache.write_batches", warm.counters)
        self.assertEqual(set(cold_vectors), set(warm_vectors))
        for frame in self.frames:
            np.testing.assert_array_equal(
                cold_vectors[frame]["hist"], warm_vectors[frame]["hist"]
            )
            np.testing.assert_array_equal(
                cold_vectors[frame]["gray"], warm_vectors[frame]["gray"]
            )

    def test_completed_embedding_batch_survives_a_later_failure(self):
        roi = ROI.full_frame(self.feature)
        first_batch = np.array(
            [[1.0, 0.0], [0.0, 1.0], [0.6, 0.8]], dtype=np.float32
        )

        def fail_after_first_batch(_cutouts, _backbone):
            yield 0, first_batch
            raise RuntimeError("synthetic second-batch failure")

        con = db.connect()
        try:
            with patch(
                "classify.embedding.iter_embed_batches",
                side_effect=fail_after_first_batch,
            ):
                with self.assertRaisesRegex(RuntimeError, "second-batch failure"):
                    classify.fetch_vectors(
                        con,
                        self.camera,
                        self.feature,
                        classify._roi_cache_key(roi),
                        roi,
                        self.frames[:5],
                        self.hmap,
                        ["resnet18"],
                        include_classical=False,
                    )
            rows = con.execute(
                "SELECT hash, feature, roi_key, kind, vec FROM score_cache ORDER BY hash"
            ).fetchall()
        finally:
            con.close()

        self.assertEqual(3, len(rows))
        self.assertEqual(
            [(f"hash-{i:02d}", self.feature, "0.0000,0.0000,1.0000,1.0000", "resnet18")
             for i in range(3)],
            [(row["hash"], row["feature"], row["roi_key"], row["kind"]) for row in rows],
        )
        for i, row in enumerate(rows):
            np.testing.assert_array_equal(
                np.frombuffer(row["vec"], dtype=np.float32), first_batch[i]
            )

    def test_dedup_reuses_shared_embedding_cache_pipeline(self):
        expected = {
            frame: {"resnet18": np.array([i + 1.0, 2.0], dtype=np.float32)}
            for i, frame in enumerate(self.frames[:3])
        }
        con = MagicMock()
        with (
            patch("dedup.embedding.backbones", return_value=["resnet18"]),
            patch("dedup.engine.resolve_roi", return_value=ROI.full_frame(self.feature)),
            patch("dedup.labels.hash_map", return_value=self.hmap),
            patch("dedup.db.connect", return_value=con),
            patch("dedup.classify.fetch_vectors", return_value=expected) as fetch,
        ):
            kept, matrix = dedup.fetch_embeddings(
                self.camera, self.feature, self.frames[:3], "resnet18"
            )

        self.assertEqual(self.frames[:3], kept)
        np.testing.assert_array_equal(matrix, np.stack([expected[f]["resnet18"] for f in kept]))
        self.assertFalse(fetch.call_args.kwargs["include_classical"])
        con.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
