from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch



import perf


class PerformanceDiagnosticsTests(unittest.TestCase):
    def test_disabled_trace_does_not_collect_spans_or_counts(self):
        with perf.trace("disabled", enabled=False, emit=False) as report:
            with perf.span("work"):
                perf.count("items", 3)

        self.assertEqual({}, dict(report.spans))
        self.assertEqual({}, dict(report.counters))

    def test_enabled_trace_aggregates_calls_and_counts(self):
        with perf.trace("enabled", enabled=True, emit=False) as report:
            for _ in range(2):
                with perf.span("work"):
                    time.sleep(0.001)
            perf.count("items", 3)

        data = report.as_dict()
        self.assertEqual(3, data["counters"]["items"])
        self.assertEqual(2, data["spans"]["work"]["calls"])
        self.assertGreater(data["spans"]["work"]["total_ms"], 0)
        self.assertGreater(data["elapsed_ms"], 0)

    def test_jsonl_output_is_opt_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "perf" / "traces.jsonl"
            with patch.dict(os.environ, {"CURATION_PERF_LOG": str(log_path)}):
                with perf.trace("logged", enabled=True):
                    perf.count("frames", 5)

            rows = log_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(1, len(rows))
            payload = json.loads(rows[0])
            self.assertEqual("logged", payload["operation"])
            self.assertEqual(5, payload["counters"]["frames"])


if __name__ == "__main__":
    unittest.main()
