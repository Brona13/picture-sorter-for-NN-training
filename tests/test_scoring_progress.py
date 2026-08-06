from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import classify
from roi import ROI


class ScoringProgressTests(unittest.TestCase):
    def test_phase_events_cover_discovery_features_and_comparison(self):
        frames = ["gold-ok.png", "gold-ng.png", "candidate-a.png", "candidate-b.png"]
        goldens = {"OK": [frames[0]], "NG": [frames[1]]}
        vectors = {
            frame: {
                "hist": np.full(8, i + 1, dtype=np.float32),
                "gray": np.full((8, 8), i / 4, dtype=np.float32),
            }
            for i, frame in enumerate(frames)
        }
        events = []
        con = MagicMock()

        prepared = classify._PreparedVectorCache(
            frame_hashes={frame: frame for frame in frames},
            blobs_by_hash={frame: {} for frame in frames},
            kept=frames,
            kinds=["hist", "gray"],
        )

        def fake_prepare(
            _con, _camera, _feature, _key, _roi, frame_list, _hmap, _bb,
            *, include_classical=True, progress_cb=None,
        ):
            self.assertTrue(include_classical)
            for done, _frame in enumerate(frame_list, start=1):
                if progress_cb:
                    progress_cb(done, len(frame_list))
            return prepared

        with (
            patch(
                "classify.engine.resolve_roi",
                return_value=ROI("feature", 0.0, 0.0, 1.0, 1.0),
            ),
            patch("classify.datamodel.classes_for", return_value=["OK", "NG"]),
            patch("classify.labels.current_goldens", return_value=goldens),
            patch("classify.datamodel.frames_for_feature", return_value=frames),
            patch("classify.labels.hash_map", return_value={f: f for f in frames}),
            patch("classify.labels.frame_hash", side_effect=lambda _c, f, _h: f),
            patch("classify.embedding.backbones", return_value=[]),
            patch("classify.methods_available", return_value=["cpu"]),
            patch("classify.db.connect", return_value=con),
            patch("classify._prepare_vector_cache", side_effect=fake_prepare),
            patch(
                "classify._decode_vectors",
                side_effect=lambda _prepared, frame_list: {
                    frame: vectors[frame] for frame in frame_list
                },
            ),
        ):
            results = classify.refresh(
                "camera",
                "feature",
                phase_progress_cb=events.append,
            )

        self.assertEqual(4, len(results))
        self.assertEqual(
            ["discovery", "discovery", "features", "features", "features", "features", "features",
             "comparison", "comparison", "comparison"],
            [event.phase for event in events],
        )
        comparison = [event for event in events if event.phase == "comparison"]
        self.assertEqual((0, 2), (comparison[0].done, comparison[0].total))
        self.assertEqual((2, 2), (comparison[-1].done, comparison[-1].total))
        self.assertEqual("cpu", comparison[-1].detail)
        con.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
