"""In-memory background jobs for long-running work (ingest, scoring, clustering...).

One worker thread runs jobs in submission order, so jobs never overlap: that
serializes work per camera/feature and keeps SQLite to a single heavy writer. The
frontend polls ``GET /api/jobs/{id}``. State lives in process memory only; a job is
lost on restart, which is fine for a local single-user tool because every job's
effects are persisted by the domain code itself.
"""
from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import APIRouter, HTTPException

import applog

QUEUED, RUNNING, DONE, ERROR = "queued", "running", "done", "error"
_MAX_KEPT = 100
_log = applog.get("jobs")


@dataclass
class Job:
    id: str
    kind: str
    camera: str
    feature: str | None = None
    status: str = QUEUED
    progress: dict[str, Any] = field(default_factory=dict)
    result: Any = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)
    request_id: str | None = None  # the request that queued it, so the log can tie the job to its click

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "camera": self.camera,
            "feature": self.feature,
            "status": self.status,
            "progress": dict(self.progress),
            "result": self.result,
            "error": self.error,
            "created": self.created,
            "updated": self.updated,
        }


class JobRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="job")

    def submit(
        self,
        kind: str,
        camera: str,
        fn: Callable[[Callable[[dict[str, Any]], None]], Any],
        feature: str | None = None,
    ) -> Job:
        """Queue ``fn(report)``; ``report(dict)`` replaces the job's progress snapshot.
        ``fn``'s return value (JSON-serialisable) becomes the job result."""
        job = Job(id=uuid.uuid4().hex, kind=kind, camera=camera, feature=feature, request_id=applog.request_id.get())
        with self._lock:
            self._jobs[job.id] = job
            self._prune()
        self._pool.submit(self._run, job, fn)
        return job

    def _run(self, job: Job, fn: Callable[[Callable[[dict[str, Any]], None]], Any]) -> None:
        self._set(job, status=RUNNING)
        applog.request_id.set(job.request_id)
        applog.camera.set(job.camera)
        applog.job_id.set(job.id)
        started = time.perf_counter()
        info = applog.fields(kind=job.kind, feature=job.feature)
        _log.info("job %s started", job.kind, extra=info)

        def report(progress: dict[str, Any]) -> None:
            self._set(job, progress=progress)

        try:
            result = fn(report)
        except Exception as exc:  # noqa: BLE001 - surface any failure to the poller
            _log.exception("job %s failed", job.kind, extra=applog.fields(kind=job.kind, feature=job.feature, duration_ms=round((time.perf_counter() - started) * 1000, 1)))
            self._set(job, status=ERROR, error=f"{type(exc).__name__}: {exc}")
        else:
            _log.info("job %s done", job.kind, extra=applog.fields(kind=job.kind, feature=job.feature, duration_ms=round((time.perf_counter() - started) * 1000, 1)))
            self._set(job, status=DONE, result=result)

    def _set(self, job: Job, **changes: Any) -> None:
        with self._lock:
            for key, value in changes.items():
                setattr(job, key, value)
            job.updated = time.time()

    def busy(self, camera: str) -> bool:
        """Whether a job of this camera is queued or running."""
        with self._lock:
            return any(j.camera == camera and j.status in (QUEUED, RUNNING) for j in self._jobs.values())

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.to_dict() if job else None

    def _prune(self) -> None:
        finished = [j for j in self._jobs.values() if j.status in (DONE, ERROR)]
        for job in sorted(finished, key=lambda j: j.created)[: max(0, len(self._jobs) - _MAX_KEPT)]:
            del self._jobs[job.id]


registry = JobRegistry()
router = APIRouter()


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
    return job
