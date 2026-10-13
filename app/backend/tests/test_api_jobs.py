from __future__ import annotations

import threading
import unittest

from api import jobs


class JobRegistryTests(unittest.TestCase):
    def wait(self, reg: jobs.JobRegistry, job_id: str) -> dict:
        import time

        for _ in range(500):
            j = reg.get(job_id)
            if j["status"] in (jobs.DONE, jobs.ERROR):
                return j
            time.sleep(0.01)
        raise AssertionError("job did not finish")

    def test_success_records_progress_and_result(self) -> None:
        reg = jobs.JobRegistry()

        def fn(report):
            report({"phase": "work", "done": 1, "total": 2})
            report({"phase": "work", "done": 2, "total": 2})
            return {"answer": 42}

        job = reg.submit("demo", "camA", fn, feature="seal")
        done = self.wait(reg, job.id)
        self.assertEqual(done["status"], jobs.DONE)
        self.assertEqual(done["result"], {"answer": 42})
        self.assertEqual(done["progress"]["done"], 2)
        self.assertEqual((done["kind"], done["camera"], done["feature"]), ("demo", "camA", "seal"))

    def test_failure_is_reported_not_raised(self) -> None:
        reg = jobs.JobRegistry()

        def boom(report):
            raise ValueError("bad input")

        done = self.wait(reg, reg.submit("demo", "camA", boom).id)
        self.assertEqual(done["status"], jobs.ERROR)
        self.assertEqual(done["error"], "ValueError: bad input")

    def test_jobs_run_one_at_a_time_in_order(self) -> None:
        reg = jobs.JobRegistry()
        gate = threading.Event()
        order: list[str] = []

        def first(report):
            gate.wait(5)
            order.append("first")

        def second(report):
            order.append("second")

        a = reg.submit("demo", "camA", first)
        b = reg.submit("demo", "camA", second)
        self.assertEqual(reg.get(b.id)["status"], jobs.QUEUED)
        gate.set()
        self.wait(reg, a.id)
        self.wait(reg, b.id)
        self.assertEqual(order, ["first", "second"])

    def test_old_finished_jobs_are_pruned(self) -> None:
        reg = jobs.JobRegistry()
        ids = []
        for _ in range(jobs._MAX_KEPT + 5):
            j = reg.submit("demo", "camA", lambda report: None)
            self.wait(reg, j.id)
            ids.append(j.id)
        self.assertIsNone(reg.get(ids[0]))
        self.assertIsNotNone(reg.get(ids[-1]))

    def test_unknown_job_is_404(self) -> None:
        from fastapi.testclient import TestClient

        from api.main import create_app

        self.assertEqual(TestClient(create_app()).get("/api/jobs/nope").status_code, 404)
