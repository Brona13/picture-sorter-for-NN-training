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
