from __future__ import annotations

import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import classify
import config
from roi import ROI


def _vector(seed: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    hist = rng.random(90, dtype=np.float32)
    hist /= np.linalg.norm(hist)
    gray = rng.random((24, 24), dtype=np.float32)
    neural = rng.random(16, dtype=np.float32)
    neural /= np.linalg.norm(neural)
    return {"hist": hist, "gray": gray, "resnet18": neural}


class ScoreBatchingTests(unittest.TestCase):
    def test_batched_scores_match_scalar_reference(self):
        classes = ["OK", "NG"]
        candidates = {f"candidate-{i}": _vector(i) for i in range(5)}
        goldens = {
            "OK": [("ok-1", _vector(101)), ("ok-2", _vector(102))],
            "NG": [("ng-1", _vector(201)), ("ng-2", _vector(202))],
        }

        expected = {
            frame: {
                method: classify._score_method(method, vecs, goldens, classes)
                for method in ("cpu", "resnet18")
            }
            for frame, vecs in candidates.items()
        }
        with ThreadPoolExecutor(max_workers=4) as executor:
            actual = classify._score_candidate_batch(
                candidates, goldens, classes, ["cpu", "resnet18"], executor
            )

        for frame in candidates:
            for method in ("cpu", "resnet18"):
                self.assertEqual(
                    expected[frame][method].leaning, actual[frame][method].leaning
                )
                for cls in classes:
                    self.assertAlmostEqual(
                        expected[frame][method].dists[cls],
                        actual[frame][method].dists[cls],
                        places=6,
                    )
                self.assertAlmostEqual(
                    expected[frame][method].margin,
                    actual[frame][method].margin,
                    places=6,
                )
                self.assertAlmostEqual(
                    expected[frame][method].novelty,
                    actual[frame][method].novelty,
                    places=6,
                )

    def test_refresh_decodes_candidates_in_bounded_groups(self):
        frames = [f"frame-{i:02d}.png" for i in range(20)]
        goldens = {"OK": [frames[0]], "NG": [frames[1]]}
        prepared = classify._PreparedVectorCache(
            frame_hashes={frame: frame for frame in frames},
            blobs_by_hash={frame: {} for frame in frames},
            kept=frames,
            kinds=["hist", "gray"],
        )
        vectors = {frame: _vector(i) for i, frame in enumerate(frames)}
        decode_groups = []
        con = MagicMock()
        old_batch_size = config.SCORING_VECTOR_BATCH_SIZE
        config.SCORING_VECTOR_BATCH_SIZE = 8

        def fake_decode(_prepared, frame_group):
            decode_groups.append(list(frame_group))
            return {frame: vectors[frame] for frame in frame_group}

        try:
            with (
                patch(
                    "classify.engine.resolve_roi",
                    return_value=ROI.full_frame("feature"),
                ),
                patch("classify.datamodel.classes_for", return_value=["OK", "NG"]),
                patch("classify.labels.current_goldens", return_value=goldens),
                patch("classify.datamodel.frames_for_feature", return_value=frames),
                patch("classify.labels.hash_map", return_value={}),
                patch("classify.embedding.backbones", return_value=[]),
                patch("classify.methods_available", return_value=["cpu"]),
                patch("classify.db.connect", return_value=con),
                patch("classify._prepare_vector_cache", return_value=prepared),
                patch("classify._decode_vectors", side_effect=fake_decode),
            ):
                results = classify.refresh("camera", "feature")
        finally:
            config.SCORING_VECTOR_BATCH_SIZE = old_batch_size

        self.assertEqual(frames, [result.frame for result in results])
        self.assertEqual(goldens["OK"] + goldens["NG"], decode_groups[0])
        self.assertEqual([8, 8, 2], [len(group) for group in decode_groups[1:]])
        con.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
