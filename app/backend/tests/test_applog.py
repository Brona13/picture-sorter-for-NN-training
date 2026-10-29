"""Logging (v1.101.0): JSON file + log database, request ids, the 500 handler, job records."""
from __future__ import annotations

import json
import os
import time
from unittest import mock

import applog
import config
from api import jobs
from api.main import create_app
from fastapi import HTTPException
from fastapi.testclient import TestClient
from tests.api_helpers import ApiTestCase


class LogTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.dir = applog.setup(config.DATA_DIR / "logs")

    def tearDown(self) -> None:
        applog.shutdown()
        super().tearDown()

    def rows(self, **kw):
        applog.flush()
        return applog.query(self.dir, **kw)

    def test_since_restart_leaves_out_records_from_before_the_backend_started(self) -> None:
        import sqlite3
        applog.get("t").error("old one")
        applog.flush()
        c = sqlite3.connect(self.dir / "logs.db")
        c.execute("UPDATE logs SET ts = ?", (applog.STARTED - 100,))
        c.commit()
        c.close()
        applog.get("t").error("new one")
        applog.flush()
        shown = [r["message"] for r in self.client.get("/api/logs", params={"level": "ERROR", "since_restart": "true"}).json()]
        self.assertIn("new one", shown)
        self.assertNotIn("old one", shown)
        everything = [r["message"] for r in self.client.get("/api/logs", params={"level": "ERROR"}).json()]
        self.assertIn("old one", everything)

    def test_nothing_is_written_before_setup_and_the_real_data_dir_is_untouched(self) -> None:
        applog.shutdown()
        applog.get("x").error("nobody listens")
        self.assertFalse((config.DATA_DIR / "logs" / "app.jsonl").exists() and "nobody" in (config.DATA_DIR / "logs" / "app.jsonl").read_text())

    def test_warning_goes_to_file_and_database_info_only_to_file_unless_audit(self) -> None:
        log = applog.get("t")
        log.info("plain info")
        log.info("kept event", extra=applog.audit(version=3))
        log.warning("careful")
        messages = [r["message"] for r in self.rows()]
        self.assertIn("careful", messages)
        self.assertIn("kept event", messages)
        self.assertNotIn("plain info", messages)
        lines = [json.loads(x) for x in (self.dir / "app.jsonl").read_text().splitlines()]
        self.assertEqual([l["message"] for l in lines], ["plain info", "kept event", "careful"])
        self.assertEqual(lines[1]["extra"], {"version": 3})

    def test_exception_keeps_the_traceback(self) -> None:
        try:
            1 / 0
        except ZeroDivisionError:
            applog.get("t").exception("boom")
        row = self.rows(level="ERROR")[0]
        self.assertIn("ZeroDivisionError", row["exc"])

    def test_request_id_is_echoed_reused_and_logged_with_the_camera(self) -> None:
        client = TestClient(create_app())
        r = client.get("/api/health", headers={"X-Request-ID": "abc123"})
        self.assertEqual(r.headers["X-Request-ID"], "abc123")
        self.assertTrue(client.get("/api/health").headers["X-Request-ID"])
        client.get("/api/cameras/nocam/rois")  # 404 or similar: logged as a warning with the camera
        rows = [r for r in self.rows(camera_name="nocam")]
        self.assertTrue(rows and all(r["camera"] == "nocam" for r in rows))

    def test_unexpected_error_is_a_logged_500_with_a_request_id(self) -> None:
        with mock.patch.dict(os.environ, {"CURATION_FRONTEND_DIST": str(config.DATA_DIR / "nodist")}):  # no SPA catch-all
            app = create_app()

        @app.get("/api/_boom")
        def boom():
            raise RuntimeError("kaput")

        r = TestClient(app, raise_server_exceptions=False).get("/api/_boom")
        self.assertEqual(r.status_code, 500)
        body = r.json()
        self.assertEqual(body["error"], "internal_error")
        self.assertEqual(body["request_id"], r.headers["X-Request-ID"])
        rows = self.rows(request=body["request_id"], level="ERROR")
        self.assertTrue(any("kaput" in (x["exc"] or "") for x in rows))

    def test_http_errors_keep_their_shape(self) -> None:
        with mock.patch.dict(os.environ, {"CURATION_FRONTEND_DIST": str(config.DATA_DIR / "nodist")}):  # no SPA catch-all
            app = create_app()

        @app.get("/api/_nope")
        def nope():
            raise HTTPException(status_code=404, detail="gone")

        r = TestClient(app).get("/api/_nope")
        self.assertEqual((r.status_code, r.json()), (404, {"detail": "gone"}))

    def test_a_failing_job_is_logged_with_its_kind_and_the_queueing_request(self) -> None:
        token = applog.request_id.set("req-77")
        try:
            def fail(_report):
                raise ValueError("job broke")
            job = jobs.registry.submit("scoring", "camJ", fail)
        finally:
            applog.request_id.reset(token)
        for _ in range(100):
            if jobs.registry.get(job.id)["status"] == "error":
                break
            time.sleep(0.05)
        rows = self.rows(request="req-77", level="ERROR")
        self.assertTrue(rows and rows[0]["job_id"] == job.id and rows[0]["camera"] == "camJ")

    def test_a_broken_database_never_raises_into_the_caller(self) -> None:
        applog.shutdown()
        blocker = config.DATA_DIR / "blocked"
        blocker.parent.mkdir(parents=True, exist_ok=True)
        blocker.write_text("a file where a directory should be")
        handler = applog.SqliteHandler(blocker / "logs.db")
        applog.get("t").addHandler(handler)
        try:
            applog.get("t").error("still fine")
            handler.flush()
        finally:
            applog.get("t").removeHandler(handler)
            handler.close()

    def test_retention_prunes_old_rows(self) -> None:
        applog.get("t").warning("old")
        applog.flush()
        import sqlite3
        c = sqlite3.connect(self.dir / "logs.db")
        c.execute("UPDATE logs SET ts = ?", (time.time() - 40 * 86400,))
        applog._prune(c)
        c.commit()
        self.assertEqual(c.execute("SELECT COUNT(*) FROM logs").fetchone()[0], 0)
        c.close()


class ClientReportTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.dir = applog.setup(config.DATA_DIR / "logs")

    def tearDown(self) -> None:
        applog.shutdown()
        super().tearDown()

    def test_frontend_errors_are_stored_with_their_request_id_and_can_be_read_back(self) -> None:
        r = self.client.post("/api/logs", json={"records": [
            {"level": "error", "message": "TypeError: x is undefined", "request_id": "r1", "camera": "camF",
             "stack": "at Foo", "breadcrumbs": ["click Save", "POST /x"], "extra": {"page": "/chain"}},
            {"level": "warn", "message": "slow"},
        ]})
        self.assertEqual(r.json(), {"stored": 2})
        rows = self.client.get("/api/logs", params={"source": "frontend", "request_id": "r1"}).json()
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["camera"], rows[0]["level"]), ("camF", "ERROR"))
        self.assertIn("click Save", rows[0]["extra"])
        self.assertEqual(len(self.client.get("/api/logs", params={"level": "WARNING"}).json()), 2)

    def test_a_batch_is_capped(self) -> None:
        r = self.client.post("/api/logs", json={"records": [{"message": "m"}] * 80})
        self.assertEqual(r.json(), {"stored": 50})


class SwallowedErrorTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.dir = applog.setup(config.DATA_DIR / "logs")
        applog._seen.clear()

    def tearDown(self) -> None:
        applog.shutdown()
        super().tearDown()

    def test_warn_once_logs_the_first_failure_of_a_kind_only(self) -> None:
        log = applog.get("t")
        for _ in range(5):
            applog.warn_once(log, "same-kind", "failed %s", "x", exc=False)
        applog.warn_once(log, "other-kind", "failed %s", "y", exc=False)
        applog.flush()
        self.assertEqual(sorted(r["message"] for r in applog.query(self.dir, level="WARNING")), ["failed x", "failed y"])

    def test_an_unreadable_picture_is_logged_where_it_used_to_vanish(self) -> None:
        import datamodel
        import flow
        from tests.api_helpers import write_frames
        names = write_frames("camL", 2)
        (datamodel.unsorted_dir("camL") / names[0]).write_bytes(b"not a picture")
        flow._frame_sizes("camL")
        applog.flush()
        rows = applog.query(self.dir, level="WARNING")
        self.assertTrue(any("cannot read the size" in r["message"] and names[0] in r["message"] for r in rows))


class RequestLineDetailTests(ApiTestCase):
    def test_a_404_line_says_why_and_keeps_the_query(self) -> None:
        directory = applog.setup(config.DATA_DIR / "logs")
        try:
            self.client.get("/api/cameras/nocam/dedup/state", params={"feature": "roi:old"})
            applog.flush()
            row = applog.query(directory, level="WARNING")[0]
            extra = json.loads(row["extra"])
            self.assertEqual(extra["query"], "feature=roi%3Aold")
            self.assertIn("Unknown", extra["detail"])
        finally:
            applog.shutdown()


class DebugTimingTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.dir = applog.setup(config.DATA_DIR / "logs")
        self.addCleanup(applog.shutdown)

    def test_timed_steps_and_all_requests_are_stored_only_while_debug_is_on(self) -> None:
        with applog.timed("step.off"):
            pass
        self.client.get("/api/health")
        applog.flush()
        self.assertEqual([r for r in applog.query(self.dir, level="DEBUG") if r["duration_ms"] is not None], [])
        self.assertEqual(self.client.put("/api/logs/debug", json={"on": True}).json(), {"on": True})
        self.assertTrue((self.dir / applog.DEBUG_FLAG).exists())
        with applog.timed("step.outer"):
            with applog.timed("step.inner", roi="seal"):
                pass
        self.client.get("/api/health")
        applog.flush()
        rows = {r["message"]: r for r in applog.query(self.dir, level="DEBUG")}
        self.assertIn("step.outer", rows)
        self.assertEqual(json.loads(rows["step.inner"]["extra"]), {"depth": 2, "roi": "seal"})
        self.assertEqual(json.loads(rows["step.outer"]["extra"])["depth"], 1)
        self.assertIn("GET /api/health -> 200", rows)
        summary = {r["name"]: r for r in self.client.get("/api/logs/timing").json()}
        self.assertEqual(summary["step.inner"]["count"], 1)
        self.assertIn("GET /api/health", summary)
        self.client.put("/api/logs/debug", json={"on": False})
        self.assertFalse((self.dir / applog.DEBUG_FLAG).exists())
        self.assertFalse(self.client.get("/api/logs/debug").json()["on"])

    def test_the_switch_survives_a_restart(self) -> None:
        applog.set_debug(True)
        applog.setup(self.dir)
        self.assertTrue(applog.is_debug())
        applog.set_debug(False)
        applog.setup(self.dir)
        self.assertFalse(applog.is_debug())

    def test_a_decorated_function_is_timed_per_call(self) -> None:
        @applog.timed("step.decorated")
        def work() -> int:
            return 7

        applog.set_debug(True)
        self.assertEqual((work(), work()), (7, 7))
        applog.flush()
        self.assertEqual(sum(1 for r in applog.query(self.dir, level="DEBUG") if r["message"] == "step.decorated"), 2)


class LogPageTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.dir = applog.setup(config.DATA_DIR / "logs")
        self.addCleanup(applog.shutdown)
        applog.set_debug(True)

    def make_request(self, rid: str, path: str, steps: list[tuple[str, float, int]], ms: float) -> None:
        from api.main import _log
        token = applog.request_id.set(rid)
        try:
            for name, step_ms, depth in steps:
                applog.get("timing").debug(name, extra=applog.fields(duration_ms=step_ms, depth=depth))
            _log.warning("GET %s -> 200", path, extra=applog.fields(method="GET", path=path, status=200, duration_ms=ms))
        finally:
            applog.request_id.reset(token)

    def test_a_page_has_a_total_an_order_and_filters(self) -> None:
        self.make_request("r1", "/api/cameras/c/chain", [("chain.canvas", 90.0, 1), ("chain.edges", 5.0, 2)], 100.0)
        self.make_request("r2", "/api/cameras/c/frames/a.jpg/thumb", [], 300.0)
        applog.get("jobs").error("boom")
        applog.flush()
        everything = self.client.get("/api/logs/page", params={"level": "DEBUG", "limit": 2}).json()
        self.assertEqual(everything["total"], 6)  # 2 steps + 2 requests + the error + the debug-on audit record
        self.assertEqual(len(everything["rows"]), 2)
        slowest = self.client.get("/api/logs/page", params={"level": "DEBUG", "order": "ms", "desc": "true"}).json()["rows"]
        self.assertEqual(slowest[0]["duration_ms"], 300.0)
        only = self.client.get("/api/logs/page", params={"level": "DEBUG", "min_ms": 95}).json()
        self.assertEqual(sorted(r["duration_ms"] for r in only["rows"]), [100.0, 300.0])
        by_text = self.client.get("/api/logs/page", params={"level": "DEBUG", "text": "chain."}).json()
        self.assertEqual(by_text["total"], 2)  # the two steps; a request path "/chain" has no dot
        by_area = self.client.get("/api/logs/page", params={"level": "DEBUG", "area": "jobs"}).json()
        self.assertEqual([r["message"] for r in by_area["rows"]], ["boom"])
        second = self.client.get("/api/logs/page", params={"level": "DEBUG", "limit": 4, "offset": 4}).json()
        self.assertEqual(len(second["rows"]), 2)

    def test_nested_lists_requests_and_gives_the_steps_of_one_on_demand(self) -> None:
        self.make_request("r1", "/api/cameras/c/chain", [("chain.edges", 5.0, 2), ("chain.canvas", 90.0, 1)], 100.0)
        applog.flush()
        top = self.client.get("/api/logs/page", params={"level": "DEBUG", "nested": "true"}).json()["rows"]
        request = next(r for r in top if r["logger"] == "http")
        self.assertEqual(request["children"], 2)
        self.assertNotIn("chain.canvas", [r["message"] for r in top])
        steps = self.client.get("/api/logs/page", params={"children_of": "r1"}).json()["rows"]
        self.assertEqual([r["message"] for r in steps], ["chain.canvas", "chain.edges"])  # started first, listed first

    def test_facets_and_grouped_thumbnail_paths(self) -> None:
        self.make_request("r1", "/api/cameras/c/frames/a.jpg/thumb", [], 300.0)
        self.make_request("r2", "/api/cameras/c/frames/b.jpg/thumb", [], 200.0)
        applog.flush()
        self.assertIn("http", self.client.get("/api/logs/facets").json()["areas"])
        rows = {r["name"]: r for r in self.client.get("/api/logs/timing").json()}
        self.assertEqual(rows["GET /api/cameras/c/frames/*/thumb"]["count"], 2)
