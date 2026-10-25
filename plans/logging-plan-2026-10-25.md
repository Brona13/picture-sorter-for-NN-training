# Logging for Picture Sorter (backend + frontend)

## Context
The app has no logging today. Backend: no `logging` import; the only diagnostics are one `traceback.print_exc()` in `api/jobs.py`, an opt-in `perf.py` (JSONL), and uvicorn's default stderr. There is no generic 500 handler, no request middleware, 47 broad `except Exception` and 15 lone `pass` sites that can swallow failures, and background threads (jobs, scatter-prewarm, embed-prep) that fail silently. Frontend: no ErrorBoundary, no `window.onerror`/`unhandledrejection`, no `console.*`; 174 `catch` blocks show errors on screen only, so nothing survives a reload. Debugging is therefore "ask the user what they saw". Goal: when something breaks, one query tells what happened, in which request, with which camera/box, and the same record can be pasted to Claude.

## Approach (industry-standard, kept small)
1. **Structured logs** (one JSON record per event, stdlib `logging`, no new dependency). Fields: time, level, source (`backend`/`frontend`), logger, message, `request_id`, `camera`, `job_id`, `duration_ms`, `exc` (traceback), `extra` (dict). Correlation through a request ID (contextvars) is the single biggest debugging gain: a frontend error, the API call and the backend traceback share one ID.
2. **Two sinks**
   - Rotating file `data/logs/app.jsonl` (size-capped, e.g. 5 x 10 MB): everything at INFO+, greppable, survives a corrupt DB.
   - SQLite table for querying in the UI: WARNING+ and selected audit events, 14-day / 50k-row retention.
3. **Separate log database `data/logs.db`, not `picture_sorter.db`.** You allowed the existing DB, but it is 273 MB, WAL-mode and written by every label click; log writes would add contention, would force a schema bump/migration, and a DB reset (`reset_database.py`) would erase the evidence. A second SQLite file gives the same query power with none of those costs. (Easy to switch to a table in the main DB if you prefer.)
4. **Backend hooks**
   - New `app/backend/applog.py`: setup, JSON formatter, contextvars, SQLite handler (batched, background-written, never raises into the caller). Log paths resolved lazily from `config.DATA_DIR` (tests change it at runtime).
   - Middleware in `api/main.py:create_app`: assign/echo `X-Request-ID`, log method/path/status/duration, WARNING for >1 s or 4xx, ERROR for 5xx. Add a generic exception handler returning `{error, detail, request_id}`.
   - `api/jobs.py` `JobRegistry.submit`: log queued/start/end/duration/exception (replaces the bare `print_exc`). Same for scatter-prewarm and embed-prep threads.
   - Audit events at INFO for rare, consequential actions only: startup (version, schema, device), migrations, freeze/revert/export, camera/ROI/box create-delete, ingest remove/keep, detector/scoring runs. Not per-label clicks (volume).
   - Sweep of swallowed exceptions: turn silent `pass`/`except Exception` into `logger.exception`/`warning` where the failure is real (case by case, not mechanical).
   - Fold `perf.py` spans into DEBUG records (fixing its stale docstring) instead of a separate format.
5. **Frontend hooks**
   - `api.ts` `request`: send/receive `X-Request-ID`, record failures (ApiError and network errors, currently unwrapped) in a client logger.
   - Global `window.onerror` + `unhandledrejection` + a React `ErrorBoundary` around routes.
   - Client logger: small ring buffer of breadcrumbs (last ~20 navigations/API calls/clicks of boxes), batched `POST /api/logs` (errors and warnings only, rate-limited, `sendBeacon` on unload). Buffer attached to each error report.
6. **Log viewer page** (under Status): filter by level, source, camera, request ID, time; expand a record; "Copy for Claude" button producing a compact text block. Plus `GET /api/logs`, `POST /api/logs`, and a retention/clear action.
7. **Levels/config**: `CURATION_LOG_LEVEL` (default INFO), `CURATION_LOG_DIR` override; DEBUG can be switched on from the Status page without restart. Guard against double handlers under `--reload`.

## Phasing (each its own version bump, tests green, push only when you say)
- **A (v1.101.0)** applog core, file + DB sinks, middleware, 500 handler, jobs/threads, startup/audit events, tests.
- **B** frontend reporter, ErrorBoundary, request-ID round trip, `POST /api/logs`.
- **C** viewer page + copy-for-Claude.
- **D** exception-swallow sweep and perf fold-in.
A + B already deliver most of the debugging value; C and D can wait.

## Benefits
Failures survive reloads and restarts; one request ID ties click -> API -> traceback; slow endpoints become visible; background-thread failures stop being silent; Windows/Linux machines each keep their own log, and a record can be pasted straight into a Claude session.

## Risks and mitigations
- Noise/disk growth: size-capped rotation, retention job, no per-click logging.
- Write contention/latency: separate DB, batched background writer, handler swallows its own errors.
- Test pollution of real `data/`: lazy path from `config.DATA_DIR`; tests use temp dirs (existing `ApiTestCase`).
- Privacy: local only; log paths and names, never picture content; frontend payload size-limited and sanitised.
- Behaviour change: the generic 500 handler changes the error body shape for unexpected errors only (adds `request_id`); existing 4xx contracts untouched.
- Sweep of `except` sites could surface formerly hidden errors: log-only, no control-flow change.

## Critical files
`app/backend/applog.py` (new), `app/backend/api/main.py`, `app/backend/api/jobs.py`, `app/backend/config.py`, `app/backend/perf.py`, `app/backend/appinfo.py` (bump), `app/frontend/src/api.ts`, new `app/frontend/src/clientLog.ts` + `ErrorBoundary.tsx`, Status view, new `api/logs.py` router; docs (`docs/current-project.md`).

## Verification
Backend tests with temp dirs (record written, request ID echoed, 500 handler, job failure logged, retention prunes, handler never raises); frontend vitest for the reporter and boundary; then headless-Chrome check on a temp server: trigger a failing call, confirm one request ID appears in the file, the DB and the viewer. Never use real `cameras/` or `data/`.

## Open questions for the user
1. Separate `logs.db` (recommended) or a table in the main DB?
2. Do you want the viewer page (phase C) or are the file + "copy" enough at first?
3. Retention: 14 days / 50k rows acceptable?
4. Anything that must never be logged (file names, camera names)?
