"""Start-up steps and progress (v1.128.0): announced in the terminal, readable at /api/startup, a failed step never stops the app."""
from __future__ import annotations

import io
from contextlib import redirect_stdout

import appinfo
import startup
from tests.api_helpers import ApiTestCase


class StartupTests(ApiTestCase):
    def run_steps(self, steps):
        out = io.StringIO()
        with redirect_stdout(out):
            startup.run(steps)
        return out.getvalue()

    def test_steps_are_announced_in_order_and_the_app_ends_ready(self) -> None:
        text = self.run_steps([("a", "First thing", lambda: "ok A"), ("b", "Second thing", lambda: "ok B")])
        lines = text.splitlines()
        self.assertEqual(lines[0], "  [1/2] First thing ...")
        self.assertTrue(lines[1].startswith("  [1/2] ok A ("))
        self.assertTrue(lines[2].startswith("  [2/2] Second thing"))
        self.assertIn(f"Picture Sorter {appinfo.VERSION} is ready", lines[-1])
        snap = self.client.get("/api/startup").json()
        self.assertTrue(snap["ready"])
        self.assertEqual([s["status"] for s in snap["steps"]], ["done", "done"])
        self.assertEqual(snap["steps"][0]["detail"], "ok A")
        self.assertEqual(snap["version"], appinfo.VERSION)

    def test_a_failing_step_is_reported_and_the_rest_still_runs(self) -> None:
        def boom() -> str:
            raise RuntimeError("no disk")

        text = self.run_steps([("a", "Breaks", boom), ("b", "Fine", lambda: "ok")])
        self.assertIn("failed: RuntimeError: no disk", text)
        self.assertIn("is ready", text)
        snap = startup.snapshot()
        self.assertEqual([s["status"] for s in snap["steps"]], ["failed", "done"])
        self.assertTrue(snap["ready"])

    def test_it_is_not_ready_while_a_step_is_running(self) -> None:
        seen = {}

        def look() -> str:
            seen.update(startup.snapshot())
            return "ok"

        self.run_steps([("a", "Looks at itself", look)])
        self.assertFalse(seen["ready"])
        self.assertEqual(seen["steps"][0]["status"], "running")
