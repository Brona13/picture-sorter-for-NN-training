---
name: session-2026-10-13-streamlit-to-react-fastapi-migration
description: Full Streamlit -> React + FastAPI migration, steps 0-12, one commit each
session_date: 2026-10-13
---

# Session 2026-10-13: Streamlit → React + FastAPI

Plan: `plans/streamlit-to-react-fastapi-migration.md` (status: completed).
Decisions: no hybrid, full refactor; `app/backend` + `app/frontend`; Vite + React + TypeScript; pytest + TestClient; Dedup included; one commit per step, no push.

## Result
- Domain modules moved to `app/backend/` (flat imports, `conftest.py` puts it on `sys.path`); routers in `app/backend/api/`.
- All seven views in `app/frontend/src/views/`. Streamlit, `scripts/`, `.streamlit/` removed.
- Background jobs (`api/jobs.py`, single worker, polled) for ingest, refresh, cluster, scatter.
- New backend modules: `thumbs.py`, `classify_view.py`, `suggest_goldens.py`, `insights.py`.
- `./run.sh` (serve / `build` / `dev`), binds 127.0.0.1, no auth.
- 135 backend + 51 frontend tests green at the end.

## Not verified
- No browser click-through (Chrome extension not connected). Real pointer drawing on the ROI canvas is untested; only simulated events and an HTTP end-to-end run against the live server.

## Notable choices
- ROI names may not contain `/` or `\`.
- Freeze takes novelty stats from the persisted results cache, not session state.
- Scatter is plain SVG; plotly dropped from `requirements-embedding.txt`.
- `STRUCTURAL_AUDIT.md` / `BEHAVIOR_INVENTORY.md` are historical (describe the Streamlit code).
- `streamlit` is still installed in `.venv` (unused).

## Follow-ups
- Do the manual browser check of every view, especially ROI draw/move/resize.
- Consider browser-level (e2e) tests.
