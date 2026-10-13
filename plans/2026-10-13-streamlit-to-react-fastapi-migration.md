# Plan: Streamlit → React + FastAPI full migration

> **Status: completed 2026-10-13** — steps 0–12 are implemented and committed (one commit per step). The browser-level click-through in step 12 could not be run (Chrome extension not connected); the full workflow was instead exercised over HTTP against the real server, plus 135 backend and 51 frontend tests.

## Context
Streamlit re-runs the script on every interaction and fights canvas/drag interaction (ROI editor). Decision: full refactor, no hybrid. Layout `app/backend` (FastAPI + existing domain code, SQLite) and `app/frontend` (Vite + React + TypeScript). Migrate view by view, backend first per view. Domain invariants in CLAUDE.md / docs/data-model.md must not change.

Decisions: domain modules `git mv` to `app/backend/` (flat imports kept); Streamlit deleted only at the end; pytest + FastAPI TestClient for new tests (pytest also runs existing unittest files); Dedup included, migrated last.

## Ground rules for every step
- Tests/verification use temp dirs via `CURATION_CAMERAS_ROOT` / `CURATION_DATA_DIR`; never the real `cameras/` or `data/picture_sorter.db`.
- Each step ends green (backend `pytest`, frontend `vitest` + `tsc`) and is its own commit (asks user before committing).
- Streamlit app keeps working until step 12.
- Update docs (README, docs/current-project.md, CLAUDE.md code boundaries) in the step that changes them.

## Steps

**0. Housekeeping.** Commit `discussions/` note. Add `node_modules`, `dist`, `.vite` to `.gitignore`. Install fastapi, pydantic, pytest, httpx into `.venv`; add `app/backend/requirements.txt` (+ dev). Test: `pip check`, import smoke.

**1. Move domain code to `app/backend/`.** `git mv` config, roi, datamodel, db, labels, versions, ingest, classify, curation, embedding, dedup, scatter, engine, perf, reset_database, and `tests/` → `app/backend/tests/`. Fix `config.PROJECT_ROOT` (now `parents[2]`) so cameras/ and data/ stay at repo root. `scripts/app.py` prepends `app/backend` to `sys.path`; `ui_common` and views stay in `scripts/`. Add `conftest.py`/pytest config for path. Test: all existing unittest files pass under pytest (Streamlit AppTest ones too); Streamlit app still starts.

**2. Backend skeleton.** `app/backend/api/main.py` (FastAPI app factory), settings read at call time (not import-captured), `DatabaseResetRequired` → 409 handler, `GET /api/health`, `GET /api/cameras`, `GET /api/cameras/{c}/products`, `/features`. Wraps `datamodel`. Test: TestClient against temp roots with synthetic camera.

**3. Frontend skeleton.** `app/frontend` Vite+React+TS, router with sidebar (camera, product, view), typed API client, dev proxy to backend. Test: vitest renders shell with mocked API; `tsc --noEmit`; `npm run build`.

**4. Status view.** `GET /api/cameras/{c}/status` (from `datamodel.list_unsorted`, `labels.counts/current_states_for_features`, `versions.summaries`). React table. Test: API test with seeded temp data; vitest component test. Establishes `render_snapshot` usage per request.

**5. Versions view.** Endpoints: list, freeze (compute stats server-side from cached results in DB; check the suspected session-state-key bug in `view_versions.py` first and add a regression test), revert, export. React forms + confirm dialog. Test: API tests for invariants (freeze→revert→export reproducibility); vitest for forms.

**6. Job infrastructure + Ingest view.** In-memory job registry (job id, phase, done/total, status), single worker, serialize per camera+feature; `GET /api/jobs/{id}` polling (SSE later if needed). Ingest: streaming multipart upload, folder-path import, rebuild index, create camera, all via existing `progress_cb`. Test: job lifecycle tests; ingest upload of synthetic images; duplicate and error phases.

**7. Frame/thumbnail serving + ROI editor.** Endpoints: full frame (ETag/mtime), ROI cutout thumb (reuse `cutout_thumb`/`thumb_data_uri` logic moved from `ui_common` into backend module), ROI CRUD (`save_rois`, `delete_roi` + `labels.purge_feature`), reference-frame setting, class list edit. React canvas for draw/move/resize in normalized coordinates (replaces `streamlit_drawable_canvas`). Test: API CRUD incl. purge invariants; vitest for coordinate math (port `box_from_object`/`fabric_rect`); manual browser check of drawing.

**8. Classify API.** Feature state (labels, goldens, counts, stale signatures computed server-side from `db.load_results`), refresh job (`classify.refresh`), label/clear/golden/bulk mutations (via `labels.*`, preserving golden⇒labeled invariant), threshold bulk + auto-assign preview, mute/delete/restore frames, grid settings persistence. Test: heavy API tests of every invariant; classical vs ResNet kept separate.

**9. Classify UI.** Controls panel, paginated card grid (thumb, per-class bars, class buttons, golden star, restore/delete), bulk and auto panels, refresh progress bar, stale warnings. Split into components mirroring `view_classify/` files. Test: vitest per component; manual end-to-end in browser against temp data.

**10. Suggest goldens + Insights.** API for suggestions (uses dedup embeddings) and per-method confusion matrices; React views. Test: API tests with synthetic embeddings (torch-optional skip); vitest for matrix.

**11. Dedup.** Cluster/scatter jobs, params persisted as settings, apply, unmute, snapshot. Scatter via plotly.js (cdn-free npm package) or lightweight canvas chart. Test: API tests with synthetic embeddings; manual check.

**12. Remove Streamlit.** Delete `scripts/` views, `ui_common`, `.streamlit/`, Streamlit/canvas/js-eval deps, Streamlit AppTest tests, `benchmark_grid_render.py`; replace `run.sh` (starts uvicorn + serves built frontend, with dev mode option) and fix `.claude/launch.json`. Rewrite README, `docs/current-project.md`, CLAUDE.md code boundaries. Test: full pytest + vitest + build; run `run.sh` against temp roots and click through every view.

## Verification (end to end)
`cd app/backend && pytest`; `cd app/frontend && npm test && npx tsc --noEmit && npm run build`; run `run.sh` with temp `CURATION_*` dirs and a synthetic camera, exercising ingest → ROI → classify → golden → freeze → export → revert → dedup in the browser.

## Risks / notes
- Flat imports + `PROJECT_ROOT` path change (step 1) is the main early-breakage risk; tests catch it.
- Tests mutate `config.X` directly; new settings code must read config at call time.
- Classify (steps 8–9) is largest; split if needed.
- Local single-user tool: no auth planned; folder-path ingest trusts the local user.
- Camera capture/log features don't exist in repo; out of scope.
