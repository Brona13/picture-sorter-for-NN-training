"""Opt-in, low-overhead performance diagnostics.

Set ``CURATION_PERF_DIAGNOSTICS=1`` before starting Streamlit to collect one
aggregate trace per view render.  When ``CURATION_PERF_LOG`` is also set, each
completed trace is appended as one JSON object per line to that file.

The module deliberately has no Streamlit dependency.  Domain code can add spans
and counters without knowing whether the caller will display, print, or persist
the resulting trace.
"""
from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator


_TRUE_VALUES = {"1", "true", "yes", "on"}
_current_trace: ContextVar["PerformanceTrace | None"] = ContextVar(
    "curation_performance_trace", default=None
)
_write_lock = threading.Lock()


def diagnostics_enabled() -> bool:
    """Return whether opt-in diagnostics are enabled for this process."""
    return os.environ.get("CURATION_PERF_DIAGNOSTICS", "").strip().lower() in _TRUE_VALUES


@dataclass
class SpanAggregate:
    calls: int = 0
    total_seconds: float = 0.0
    min_seconds: float = float("inf")
    max_seconds: float = 0.0

    def add(self, elapsed: float) -> None:
        self.calls += 1
        self.total_seconds += elapsed
        self.min_seconds = min(self.min_seconds, elapsed)
        self.max_seconds = max(self.max_seconds, elapsed)

    def as_dict(self) -> dict:
        return {
            "calls": self.calls,
            "total_ms": round(self.total_seconds * 1000, 3),
            "min_ms": round(self.min_seconds * 1000, 3) if self.calls else 0.0,
            "max_ms": round(self.max_seconds * 1000, 3),
        }


@dataclass
class PerformanceTrace:
    operation: str
    context: dict = field(default_factory=dict)
    enabled: bool = True
    started: float = field(default_factory=time.perf_counter)
    spans: dict[str, SpanAggregate] = field(default_factory=lambda: defaultdict(SpanAggregate))
    counters: dict[str, int | float] = field(default_factory=lambda: defaultdict(int))
    elapsed_seconds: float = 0.0
    error: str | None = None

    def record_span(self, name: str, elapsed: float) -> None:
        if self.enabled:
            self.spans[name].add(elapsed)

    def add_count(self, name: str, amount: int | float = 1) -> None:
        if self.enabled:
            self.counters[name] += amount

    def finish(self) -> None:
        self.elapsed_seconds = time.perf_counter() - self.started

    def as_dict(self) -> dict:
        return {
            "operation": self.operation,
            "elapsed_ms": round(self.elapsed_seconds * 1000, 3),
            "context": self.context,
            "counters": dict(sorted(self.counters.items())),
            "spans": {name: agg.as_dict() for name, agg in sorted(self.spans.items())},
            "error": self.error,
        }

    def table_rows(self) -> list[dict]:
        """Rows suitable for a compact Streamlit diagnostics table."""
        rows = [
            {
                "Phase": name,
                "Calls": agg.calls,
                "Total ms": round(agg.total_seconds * 1000, 1),
                "Max ms": round(agg.max_seconds * 1000, 1),
            }
            for name, agg in self.spans.items()
        ]
        return sorted(rows, key=lambda row: row["Total ms"], reverse=True)


def current_trace() -> PerformanceTrace | None:
    return _current_trace.get()


@contextmanager
def trace(
    operation: str,
    *,
    enabled: bool | None = None,
    emit: bool = True,
    **context,
) -> Iterator[PerformanceTrace]:
    """Collect aggregate spans and counters for one top-level operation."""
    active = diagnostics_enabled() if enabled is None else enabled
    report = PerformanceTrace(operation=operation, context=context, enabled=active)
    token = _current_trace.set(report if active else None)
    try:
        yield report
    except Exception as exc:
        report.error = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        report.finish()
        _current_trace.reset(token)
        if active and emit:
            emit_trace(report)


@contextmanager
def span(name: str) -> Iterator[None]:
    """Measure a named phase when a trace is active; otherwise do almost nothing."""
    report = current_trace()
    if report is None:
        yield
        return
    started = time.perf_counter()
    try:
        yield
    finally:
        report.record_span(name, time.perf_counter() - started)


def count(name: str, amount: int | float = 1) -> None:
    """Increment a named workload or behavior counter on the active trace."""
    report = current_trace()
    if report is not None:
        report.add_count(name, amount)


def emit_trace(report: PerformanceTrace) -> None:
    """Append a trace as JSONL when ``CURATION_PERF_LOG`` is configured."""
    raw_path = os.environ.get("CURATION_PERF_LOG", "").strip()
    if not raw_path:
        return
    path = Path(raw_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(report.as_dict(), sort_keys=True, ensure_ascii=False)
    with _write_lock:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
