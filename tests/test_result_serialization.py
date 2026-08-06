from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import classify


class ResultSerializationTests(unittest.TestCase):
    def test_round_trip_preserves_goldens_methods_and_distances(self):
        golden = classify.FrameScore(frame="golden.png", golden="OK")
        candidate = classify.FrameScore(frame="candidate.png", golden=None)
        candidate.per_method["cpu"] = classify.MethodScore(
            dists={"OK": 0.125, "NG": 0.375},
            leaning="OK",
            margin=0.25,
            novelty=0.125,
        )

        blob = classify.serialise_results([golden, candidate])
        restored = classify.deserialise_results(blob)

        self.assertEqual(blob, classify.serialise_results(restored))
        self.assertEqual("OK", restored[0].golden)
        self.assertEqual({}, restored[0].per_method)
        self.assertEqual(candidate.per_method["cpu"], restored[1].per_method["cpu"])

    def test_obsolete_payload_without_required_fields_is_rejected(self):
        blob = json.dumps(
            [
                {"frame": "old-golden.png", "golden": "NG"},
                {
                    "frame": "old-candidate.png",
                    "per_method": {
                        "cpu": {
                            "dists": {"OK": 0.4, "NG": 0.2},
                            "leaning": "NG",
                            "margin": 0.2,
                        }
                    },
                },
            ]
        ).encode("utf-8")

        with self.assertRaises(KeyError):
            classify.deserialise_results(blob)


if __name__ == "__main__":
    unittest.main()
