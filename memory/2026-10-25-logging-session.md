---
name: logging-session
description: Session 2026-10-25 (v1.101.0-v1.104.1) - application logging in four phases - JSON file + separate log database, request ids, frontend error reporter, Log page, swallowed-error sweep; decisions, how to read a log, mistakes, open items
status: current
document_type: memory
session_date: 2026-10-25
---

# Session 2026-10-25: Logging (v1.101.0 - v1.104.1)

Plan (approved): `plans/logging-plan-2026-10-25.md`. Reference: `docs/current-project.md` (four "Logging" entries) and README "Troubleshooting → Logs".

## Also done this session
- `git pull` brought v1.81.0 -> v1.100.1 (Picture edits panel, zone scatter, Offset operation, handover notes).
- A reported "cannot connect ROI product to a detector" was a stale Chain page in the browser after an app update; deleting and recreating the box worked. Code and tests had no fault. Lesson: after an update, hard-refresh before debugging.
- `discussions/`: every note now has front matter (name, description, status, document_type, last_updated) for the Dataview index. The user says the newer notes are **not historical**: they hold work to take (training/docs cleanup to-dos, chain redesign, north star). Statuses were set to `current`.

## What was built
| Version | Phase | Content |
|---|---|---|
| 1.101.0 | A | `app/backend/applog.py`: JSON records, rotating `data/logs/app.jsonl`, separate `data/logs/logs.db` (WARNING+ and audit events, 14 days / 50k rows). Request middleware with `X-Request-ID`, logged 500 handler, job start/end/failure. |
| 1.102.0 | B | `clientLog.ts`, `ErrorBoundary.tsx`, `api.ts` sends `X-Request-ID`; `POST/GET /api/logs`. 4xx not reported by the browser. |
| 1.103.0 | C | Log page (Overview -> Log): filters, request-id drill-down, "Copy N for Claude". |
| 1.104.0 | D | Swallowed `except Exception` sites now log; `applog.warn_once` for per-picture failures. |
| 1.104.1 | - | Request log line carries the query string and the HTTP error reason. |

## Decisions
- Separate `logs.db`, not a table in `picture_sorter.db` (273 MB, WAL, label writes; a DB reset would erase evidence). Logging starts in the server lifespan only, so tests never write to the real `data/`.
- Audit events (`applog.audit(...)`) only for rare, consequential actions; never per label click.
- The user did not answer the four open questions; defaults used (separate DB, viewer page yes, 14 days / 50k rows, nothing excluded).

## How to read a log (for a new session)
Log page, or `data/logs/app.jsonl` (INFO+), or read-only `sqlite3 data/logs/logs.db`. One request id ties the click, the API call and the traceback. First real finding: a 404 on `dedup/state` for a camera without a Dedup box (a page from before the update).

## Mistakes to avoid
- `git add -A` committed `data/logs/logs.db(-shm/-wal)` in `bd247a6` (pushed). Fixed in `58c92a9` (`data/logs/` ignored). The files remain in history; removing them needs a force-push, not done, user not asked.
- `pkill -f` killed the shell again; use `fuser -k <port>/tcp`.
- Headless-Chrome helper scripts hung twice on stale Chrome processes; use a fresh port and profile and a `timeout`.

## Open items
- Slow first-load requests (>1 s, torch import) are logged as WARNING; raise the threshold or exempt `/api/device` and `/api/config/methods` if noisy.
- Not yet used: audit events for freeze/export/camera delete/ROI changes (planned in the approach, only startup is audited so far).
- Runtime DEBUG switch from the Status page was in the plan, not built (`CURATION_LOG_LEVEL` only).
- The remaining bare `pass` blocks that parse values were left alone.
