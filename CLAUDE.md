# Picture Sorter for NN Training

## Purpose

This project helps a human curate compact, reliable image datasets for camera-based vision classification. Machine-generated scores assist review; they never replace the human label.

## Read before working

Start with:

1. `README.md` for setup and the current user workflow.
2. `docs/methodology.md` when working on scoring or curation behavior.
3. `docs/current-project.md` for current architecture, capabilities, limitations, and open work.
4. `docs/data-model.md` for canonical entities and domain invariants.

Files in `memory/` and `plans/` may describe earlier workflows. Treat `docs/current-project.md`, `docs/data-model.md`, and active code as authoritative. Read historical files only when their rationale is relevant to the task.

## Core invariants

- Source frames are immutable and remain in
  `cameras/<camera>/unsorted/`.
- Labels, golden marks, and versions are metadata; classification does not move source frames.
- A golden is always a labeled frame and inherits that label.
- An unlabeled frame cannot be golden.
- Relabeling a golden changes its reference class to the new label.
- Labels and goldens are scoped by camera, feature, and frame.
- A feature is a named ROI; normalized ROI coordinates are stored in the SQLite `rois` table, keyed by `(camera, name)`.
- A `role="classify"` ROI defines the product classes for a camera.
- Product-specific feature identifiers use `<product>::<roi>`.
- Classical and ResNet scoring methods are independent opinions and must not be blended.
- Exports are reproducible outputs generated from frozen versions.

## Code boundaries

- `app/backend/api/`: FastAPI routers (thin; one per area) and `api/main.py` app factory.
- `app/backend/datamodel.py`: cameras, products, features, and frame selection.
- `app/backend/db.py`: SQLite schema and low-level persistence.
- `app/backend/labels.py`: label and golden state.
- `app/backend/classify.py`: multi-class scoring and score caching.
- `app/backend/versions.py`: freeze, revert, and export behavior.
- `app/backend/classify_view.py`, `suggest_goldens.py`, `insights.py`, `thumbs.py`: presentation-neutral Classify/Insights logic.
- `app/frontend/src/`: React + TypeScript UI (`views/`, `classify/`, `api.ts`).

Keep domain logic out of API routers and React components when practical.
Domain modules use flat imports (`import labels`) with `app/backend` on `sys.path`.

Logging: use `applog.get("area")` (`app/backend/applog.py`); never `print`. Logs live in `data/logs/` (not in Git) and are read on the Log page; tests must not call `applog.setup()` without a temp directory.

Run backend tests with `.venv/bin/python -m pytest`; frontend with `cd app/frontend && npm test && npx tsc --noEmit`.
Launch with `./run.sh` (see README). History: `plans/streamlit-to-react-fastapi-migration.md`.

## Safe working rules

- Never test against the real `cameras/` directory or
  `data/picture_sorter.db`.
- For tests and verification, set `CURATION_CAMERAS_ROOT` and
  `CURATION_DATA_DIR` to temporary directories.
- Do not modify, move, or delete real camera frames or generated exports unless the user explicitly requests it.
- Bump `VERSION` and `RELEASED` in `app/backend/appinfo.py` with every code change (patch for small changes, minor for features).
- Keep direct label/golden state transactionally consistent; deliberate history belongs in Versions.
- When changing a domain invariant, update its canonical documentation and behavior tests in the same change.

## Context efficiency

Do not scan these by default:

- `.venv/`
- `cameras/*/unsorted/`
- `cameras/*/exports/`
- `app/**/__pycache__/`
- `app/frontend/node_modules/`, `app/frontend/dist/`
- historical plans or memory notes

Inspect them only when the task specifically requires their data or history. Prefer targeted searches and relevant modules over repository-wide reads.
