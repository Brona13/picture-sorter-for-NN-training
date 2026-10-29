"""Start-up steps and progress (v1.128.0): announced in the terminal, readable at /api/startup, a failed step never stops the app."""
from __future__ import annotations

import io
import re
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


class FancyScreenTests(ApiTestCase):
    """The terminal screen (boxes, spinner) is cosmetic but must not change what the steps do or break on a failing step."""

    def test_box_is_as_wide_as_its_longest_plain_row(self) -> None:
        import termui

        lines = termui.box([("short", "\033[1mshort\033[0m"), ("a longer row", "a longer row")], "").splitlines()
        plain = [re.sub(r"\033\[[0-9;]*m", "", line) for line in lines]
        self.assertEqual({len(line) for line in plain}, {len(plain[0])})

    def test_fancy_run_shows_the_url_and_still_reports_a_failing_step(self) -> None:
        import termui
        from unittest import mock

        def boom() -> str:
            raise RuntimeError("no disk")

        out = io.StringIO()
        with mock.patch.object(termui, "fancy", return_value=True), redirect_stdout(out):
            startup.run([("a", "Loading thing (takes a while)", boom), ("b", "Fine", lambda: "ok")])
        text = out.getvalue()
        self.assertIn("failed: RuntimeError: no disk", text)
        self.assertIn("Ready", text)
        self.assertIn("http://127.0.0.1:8999", text)
        self.assertEqual([s["status"] for s in startup.snapshot()["steps"]], ["failed", "done"])
