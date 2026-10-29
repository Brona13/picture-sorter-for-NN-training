"""Start-up progress: what the backend does before it is fully ready, shown in the terminal and at ``GET /api/startup``.

The first neural-scoring request after a start used to load PyTorch (about 6 s on a Windows laptop) in the middle of
whatever the person was doing. The steps below run in a background thread right after the server starts, so that wait
happens at launch, and each step is announced in the terminal the app was started from. The page is usable meanwhile;
a request that needs PyTorch before it is loaded simply waits for the same import. Nothing here runs in tests (only the
server's lifespan starts it).
"""
from __future__ import annotations

import threading
import time
from typing import Callable

import appinfo
import applog
import config

_log = applog.get("startup")
_lock = threading.Lock()
_state: dict = {"ready": False, "version": appinfo.VERSION, "steps": [], "started": None, "seconds": None}


def _say(text: str) -> None:
    """One line in the terminal the app was started from (the server's own banner does the same)."""
    print(text, flush=True)


def snapshot() -> dict:
    """The progress so far, as the page shows it."""
    with _lock:
        return {**_state, "steps": [dict(s) for s in _state["steps"]]}


def _set(index: int, **values: object) -> None:
    with _lock:
        _state["steps"][index].update(values)


def _read_cameras() -> str:
    import datamodel  # noqa: PLC0415

    n = len(datamodel.list_cameras())
    return f"{n} camera{'s' if n != 1 else ''}"


def _load_torch() -> str:
    import embedding  # noqa: PLC0415

    if not getattr(config, "EMBEDDING_ENABLED", True):
        return "skipped: neural scoring is switched off in the configuration"
    if not embedding._ensure_torch():
        return "not installed: neural scoring is unavailable (everything else works)"
    return "loaded"


def _detect_device() -> str:
    import embedding  # noqa: PLC0415

    return embedding.device_label()


STEPS: list[tuple[str, str, Callable[[], str]]] = [
    ("cameras", "Reading the camera list", _read_cameras),
    ("pytorch", "Loading PyTorch for neural scoring (about 6 s the first time, up to a minute on a slow disk)", _load_torch),
    ("device", "Detecting the processor / graphics card", _detect_device),
]


def run(steps: list[tuple[str, str, Callable[[], str]]] | None = None) -> None:
    """Run the steps in order, announcing each; never raises (a failed step is reported and the app goes on)."""
    steps = steps if steps is not None else STEPS
    t0 = time.perf_counter()
    with _lock:
        _state.update(ready=False, started=time.time(), seconds=None, steps=[{"key": k, "label": label, "status": "waiting", "detail": "", "seconds": None} for k, label, _ in steps])
    total = len(steps)
    for i, (key, label, work) in enumerate(steps):
        _set(i, status="running")
        _say(f"  [{i + 1}/{total}] {label} ...")
        began = time.perf_counter()
        try:
            detail = work()
            status = "done"
        except Exception as exc:  # noqa: BLE001 - a start-up step must never stop the app
            detail, status = f"failed: {type(exc).__name__}: {exc}", "failed"
            _log.warning("start-up step %s failed", key, exc_info=True)
        seconds = round(time.perf_counter() - began, 1)
        _set(i, status=status, detail=detail, seconds=seconds)
        _say(f"  [{i + 1}/{total}] {detail} ({seconds} s)")
        _log.info("start-up step %s", key, extra=applog.fields(step=key, status=status, detail=detail, duration_ms=round(seconds * 1000)))
    took = round(time.perf_counter() - t0, 1)
    with _lock:
        _state.update(ready=True, seconds=took)
    _say(f"Picture Sorter {appinfo.VERSION} is ready ({took} s). You can use it now.")
    _log.info("ready", extra=applog.audit(version=appinfo.VERSION, seconds=took))


def start() -> threading.Thread:
    """Begin the steps in a background thread (the server keeps answering meanwhile)."""
    with _lock:
        _state.update(ready=False, version=appinfo.VERSION)
    thread = threading.Thread(target=run, name="startup", daemon=True)
    thread.start()
    return thread
