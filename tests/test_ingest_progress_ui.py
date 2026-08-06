from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import ingest
import view_ingest


class IngestProgressUITests(unittest.TestCase):
    def test_domain_phase_and_counts_are_visible(self):
        status = MagicMock()
        bar = MagicMock()
        status.progress.return_value = bar
        with patch.object(view_ingest.st, "status", return_value=status):
            progress = view_ingest._IngestProgressUI("Starting")
            progress(
                ingest.IngestProgress(
                    phase="hashing",
                    done=5,
                    total=10,
                    detail="2/8 · frame.png",
                    added=1,
                    skipped=2,
                    errors=0,
                )
            )

        status.update.assert_called_with(
            label="Hashing and staging for exact duplicate detection…",
            state="running",
            expanded=True,
        )
        fraction, = bar.progress.call_args.args
        text = bar.progress.call_args.kwargs["text"]
        self.assertEqual(0.5, fraction)
        self.assertIn("frame.png", text)
        self.assertIn("added 1, duplicates 2, errors 0", text)

    def test_completion_summary_includes_partial_errors(self):
        status = MagicMock()
        bar = MagicMock()
        status.progress.return_value = bar
        with patch.object(view_ingest.st, "status", return_value=status):
            progress = view_ingest._IngestProgressUI("Starting")
            progress.complete(
                ingest.IngestResult(
                    added=["a.png"], skipped=["duplicate.png"], errors=["bad.png: failed"]
                )
            )

        final_text = bar.progress.call_args.kwargs["text"]
        self.assertIn("added 1, duplicates 1, errors 1", final_text)
        status.update.assert_called_with(
            label=final_text, state="complete", expanded=False,
        )


if __name__ == "__main__":
    unittest.main()
