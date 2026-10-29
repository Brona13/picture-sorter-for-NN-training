"""Application logging: one JSON record per event, a rotating file and a queryable SQLite sink.

Use ``log = applog.get("flow")`` in a module, then ``log.info(...)``/``log.exception(...)``.
``log.info("frozen", extra=applog.audit(version=3))`` marks an audit event that is kept in the
log database even though it is below WARNING.

Nothing is written until ``setup()`` runs (the server calls it at startup), so importing the
app in tests never touches the real ``data/``. Records carry ``request_id``/``camera``/``job_id``
from context variables, so a frontend error, its API call and the backend traceback share one id.
The log database (``logs.db``) is separate from ``picture_sorter.db`` on purpose: log writes
never contend with label writes and a database reset does not erase the evidence.
"""
from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import logging.handlers
import queue
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import config

ROOT = "picturesorter"
RETENTION_DAYS = 14
RETENTION_ROWS = 50_000
_DB_LEVEL = logging.WARNING  # records below this reach logs.db only when marked as audit (DEBUG while the debug switch is on)
_PRUNE_EVERY = 500  # writes between retention passes

request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
camera: contextvars.ContextVar[str | None] = contextvars.ContextVar("camera", default=None)
job_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("job_id", default=None)
# Filled by the HTTP error handler so the request log line can say why a request failed.
request_info: contextvars.ContextVar[dict | None] = contextvars.ContextVar("request_info", default=None)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    level TEXT NOT NULL,
    source TEXT NOT NULL,
    logger TEXT NOT NULL,
    message TEXT NOT NULL,
    request_id TEXT,
    camera TEXT,
    job_id TEXT,
    duration_ms REAL,
    exc TEXT,
    extra TEXT,
    audit INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts);
CREATE INDEX IF NOT EXISTS logs_request ON logs (request_id);
"""
_COLUMNS = ("ts", "level", "source", "logger", "message", "request_id", "camera", "job_id", "duration_ms", "exc", "extra", "audit")


STARTED = time.time()  # when this backend process started: the log view can show only what happened since


def get(name: str) -> logging.Logger:
    """The logger of one module/area, e.g. ``applog.get("jobs")``."""
    return logging.getLogger(f"{ROOT}.{name}")


_seen: set[str] = set()


def warn_once(logger: logging.Logger, key: str, message: str, *args: Any, exc: bool = True) -> None:
    """Warn the first time ``key`` fails in this process; a loop over many pictures must not flood the log.

    ``key`` names the kind of failure (and what failed, e.g. the frame), not the exception text."""
    if key in _seen or len(_seen) > 500:
        return
    _seen.add(key)
    logger.warning(message, *args, exc_info=exc)


def audit(**fields: Any) -> dict[str, Any]:
    """``extra=`` for an event worth keeping in the log database: ``log.info("frozen", extra=applog.audit(version=3))``."""
    return {"audit": True, "fields": fields}


def fields(**values: Any) -> dict[str, Any]:
    """``extra=`` carrying structured fields (including ``duration_ms``) without the audit mark."""
    return {"fields": values}


def _record_dict(record: logging.LogRecord) -> dict[str, Any]:
    """The stored shape of a record; shared by the file formatter and the database sink."""
    data = dict(getattr(record, "fields", None) or {})
    source = data.pop("source", "backend")
    duration = data.pop("duration_ms", None)
    exc = None
    if record.exc_info:
        exc = logging.Formatter().formatException(record.exc_info)
    return {
        "ts": record.created,
        "level": record.levelname,
        "source": source,
        "logger": record.name.removeprefix(f"{ROOT}."),
        "message": record.getMessage(),
        "request_id": data.pop("request_id") if "request_id" in data else request_id.get(),  # an explicit None (a frontend report with no id) must not inherit the POST's
        "camera": data.pop("camera", None) or camera.get(),
        "job_id": job_id.get(),
        "duration_ms": duration,
        "exc": exc,
        "extra": json.dumps(data, default=str) if data else None,
        "audit": 1 if getattr(record, "audit", False) else 0,
    }


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        row = _record_dict(record)
        row["time"] = datetime.fromtimestamp(row.pop("ts"), timezone.utc).isoformat(timespec="milliseconds")
        row.pop("audit")
        if row["extra"]:
            row["extra"] = json.loads(row["extra"])
        return json.dumps({k: v for k, v in row.items() if v is not None}, default=str)


class SqliteHandler(logging.Handler):
    """Queues records and writes them in batches from a background thread; never raises into the caller."""

    def __init__(self, path: Path) -> None:
        super().__init__(level=logging.DEBUG)
        self.path = path
        self._queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=10_000)
        self._writes = 0
        self._thread = threading.Thread(target=self._work, name="log-writer", daemon=True)
        self._thread.start()

    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno < (logging.DEBUG if _state["debug"] else _DB_LEVEL) and not getattr(record, "audit", False):
            return
        try:
            self._queue.put_nowait(_record_dict(record))
        except Exception:  # noqa: BLE001 - a full queue or bad record must never break the caller
            pass

    def _work(self) -> None:
        while True:
            item = self._queue.get()
            batch = [item]
            try:
                while len(batch) < 200:
                    batch.append(self._queue.get(timeout=0.2))
            except queue.Empty:
                pass
            stop = None in batch
            self._write([b for b in batch if b is not None])
            for _ in batch:
                self._queue.task_done()
            if stop:
                return

    def _write(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        try:
            with _open(self.path) as conn:
                conn.executemany(
                    f"INSERT INTO logs ({', '.join(_COLUMNS)}) VALUES ({', '.join('?' * len(_COLUMNS))})",
                    [tuple(r[c] for c in _COLUMNS) for r in rows],
                )
                self._writes += len(rows)
                if self._writes >= _PRUNE_EVERY:
                    self._writes = 0
                    _prune(conn)
        except Exception:  # noqa: BLE001, S110 - logging must never take the app down
            pass

    def flush(self) -> None:
        self._queue.join()

    def close(self) -> None:
        try:
            self._queue.put(None, timeout=1)
            self._thread.join(timeout=3)
        except Exception:  # noqa: BLE001, S110
            pass
        super().close()


def _open(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(_SCHEMA)
    return _Commit(conn)


class _Commit:
    """Context manager that commits and closes (sqlite3's own only commits)."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def __enter__(self) -> sqlite3.Connection:
        return self.conn

    def __exit__(self, *exc: object) -> None:
        try:
            if exc[0] is None:
                self.conn.commit()
        finally:
            self.conn.close()


def _prune(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM logs WHERE ts < ?", (time.time() - RETENTION_DAYS * 86400,))
    conn.execute("DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?", (RETENTION_ROWS,))


_state: dict[str, Any] = {"dir": None, "db": None, "file": None, "debug": False, "level": logging.INFO}
DEBUG_FLAG = "debug.flag"  # a file in the log directory: the debug switch survives a restart


def log_dir() -> Path:
    return config.DATA_DIR / "logs"


def setup(directory: Path | None = None, level: int | str | None = None) -> Path:
    """Attach the file and database sinks (idempotent; a second call re-points them). Returns the log directory.

    ``level`` defaults to ``CURATION_LOG_LEVEL`` (INFO); ``CURATION_LOG_DIR`` overrides the directory."""
    import os  # noqa: PLC0415

    shutdown()
    directory = Path(directory or os.environ.get("CURATION_LOG_DIR") or log_dir())
    directory.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger(ROOT)
    base = level or os.environ.get("CURATION_LOG_LEVEL", "INFO").upper()
    root.setLevel(base)
    _state["level"] = root.level
    _state["debug"] = (directory / DEBUG_FLAG).exists() or root.level <= logging.DEBUG
    if _state["debug"]:
        root.setLevel(logging.DEBUG)
    root.propagate = False
    file_handler = logging.handlers.RotatingFileHandler(directory / "app.jsonl", maxBytes=10_000_000, backupCount=4, encoding="utf-8")
    file_handler.setFormatter(JsonFormatter())
    file_handler.setLevel(logging.DEBUG if _state["debug"] else logging.INFO)
    db_handler = SqliteHandler(directory / "logs.db")
    root.addHandler(file_handler)
    root.addHandler(db_handler)
    _state.update(dir=directory, db=db_handler, file=file_handler)
    return directory


def is_debug() -> bool:
    return bool(_state["debug"])


def set_debug(on: bool) -> bool:
    """Switch the debug mode: every request (also the fast GETs) and every timed step (``timed``) is written to the
    file and to the log database with its duration. Off, only warnings, errors and audit events reach the database.
    The switch is remembered in the log directory (``debug.flag``), so it survives a restart."""
    root = logging.getLogger(ROOT)
    _state["debug"] = bool(on)
    root.setLevel(logging.DEBUG if on else _state["level"])
    if _state["file"] is not None:
        _state["file"].setLevel(logging.DEBUG if on else logging.INFO)
    directory = _state["dir"]
    if directory is not None:
        flag = Path(directory) / DEBUG_FLAG
        try:
            if on:
                flag.touch()
            else:
                flag.unlink(missing_ok=True)
        except OSError:
            pass
    get("log").info("debug mode %s", "on" if on else "off", extra=audit(debug=bool(on)))
    return bool(on)


_depth: contextvars.ContextVar[int] = contextvars.ContextVar("span_depth", default=0)


class timed(contextlib.ContextDecorator):  # noqa: N801 - used like a function: ``with applog.timed("chain.canvas"):``
    """Time a step. Nothing happens (one flag check) unless the debug mode is on; then a DEBUG record ``name`` with
    ``duration_ms`` (and ``depth``: how many timed steps it sits inside, so the log reads as a tree) is written.
    Also usable as a decorator: ``@applog.timed("flow.sync")``. ``detail`` is stored with the record."""

    def __init__(self, name: str, **detail: Any) -> None:
        self.name = name
        self.detail = detail
        self._token = None
        self._t0 = 0.0

    def _recreate_cm(self) -> "timed":
        return timed(self.name, **self.detail)  # a decorated function may run in several threads at once: one object per call

    def __enter__(self) -> "timed":
        if _state["debug"]:
            self._t0 = time.perf_counter()
            self._token = _depth.set(_depth.get() + 1)
        return self

    def __exit__(self, *exc: object) -> None:
        if self._token is None:
            return
        ms = round((time.perf_counter() - self._t0) * 1000, 1)
        _depth.reset(self._token)
        self._token = None
        get("timing").debug(self.name, extra=fields(duration_ms=ms, depth=_depth.get() + 1, **self.detail))


def timing_summary(directory: Path | None = None, *, since: float | None = None, limit: int = 8000) -> list[dict[str, Any]]:
    """Where the time went: records with a duration grouped by what they measured (a request path or a timed step),
    slowest total first. Needs the debug mode to have been on."""
    path = Path(directory or _state["dir"] or log_dir()) / "logs.db"
    if not path.exists():
        return []
    sql = "SELECT logger, message, duration_ms, extra FROM logs WHERE duration_ms IS NOT NULL"
    args: list[Any] = []
    if since is not None:
        sql += " AND ts >= ?"
        args.append(since)
    sql += " ORDER BY id DESC LIMIT ?"
    groups: dict[tuple[str, str], list[float]] = {}
    with _open(path) as conn:
        for row in conn.execute(sql, (*args, limit)):
            name = row["message"]
            if row["logger"] == "http":
                try:
                    info = json.loads(row["extra"] or "{}")
                    name = f"{info.get('method', '')} {info.get('path', name)}".strip()
                except ValueError:
                    pass
            groups.setdefault((row["logger"], name), []).append(row["duration_ms"])
    out = []
    for (logger, name), values in groups.items():
        values.sort()
        out.append({
            "kind": "request" if logger == "http" else "step", "name": name, "count": len(values),
            "total_ms": round(sum(values), 1), "avg_ms": round(sum(values) / len(values), 1),
            "p95_ms": values[min(len(values) - 1, int(len(values) * 0.95))], "max_ms": values[-1],
        })
    return sorted(out, key=lambda r: r["total_ms"], reverse=True)[:60]


def shutdown() -> None:
    """Drain and detach the sinks (tests, re-setup, process exit)."""
    root = logging.getLogger(ROOT)
    for key in ("db", "file"):
        handler = _state.get(key)
        if handler is not None:
            root.removeHandler(handler)
            handler.close()
        _state[key] = None
    _state["dir"] = None
    _state["debug"] = False


def flush() -> None:
    if _state["db"] is not None:
        _state["db"].flush()


def record_external(level: str, message: str, source: str, **values: Any) -> None:
    """A record that did not originate in this process' code (the frontend reporter)."""
    levelno = logging.getLevelName(level.upper())
    if not isinstance(levelno, int):
        levelno = logging.ERROR
    get(source).log(levelno, message, extra={"fields": {"source": source, **values}})


def query(directory: Path | None = None, *, level: str | None = None, source: str | None = None, camera_name: str | None = None,
          request: str | None = None, since: float | None = None, limit: int = 200) -> list[dict[str, Any]]:
    """Newest first. ``level`` is a minimum (``WARNING`` gives WARNING and ERROR)."""
    path = Path(directory or _state["dir"] or log_dir()) / "logs.db"
    if not path.exists():
        return []
    order = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
    where, args = [], []
    if level and level.upper() in order:
        where.append(f"level IN ({', '.join('?' * len(order[order.index(level.upper()):]))})")
        args += order[order.index(level.upper()):]
    for column, value in (("source", source), ("camera", camera_name), ("request_id", request)):
        if value:
            where.append(f"{column} = ?")
            args.append(value)
    if since is not None:
        where.append("ts >= ?")
        args.append(since)
    sql = "SELECT * FROM logs" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY id DESC LIMIT ?"
    with _open(path) as conn:
        return [dict(r) for r in conn.execute(sql, (*args, max(1, min(int(limit), 1000))))]
