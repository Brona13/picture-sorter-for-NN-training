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
- A feature is a named ROI; normalized ROI coordinates are stored in `cameras/<camera>/rois.json`.
- A `role="classify"` ROI defines the product classes for a camera.
- Product-specific feature identifiers use `<product>::<roi>`.
- Classical and ResNet scoring methods are independent opinions and must not be blended.
- Exports are reproducible outputs generated from frozen versions.

## Code boundaries

- `scripts/app.py`: Streamlit entry point and view routing.
- `app/backend/datamodel.py`: cameras, products, features, and frame selection.
- `app/backend/db.py`: SQLite schema and low-level persistence.
- `app/backend/labels.py`: label and golden state.
- `app/backend/classify.py`: multi-class scoring and score caching.
- `app/backend/versions.py`: freeze, revert, and export behavior.
- `scripts/view_*/`: Streamlit presentation and interaction.

Keep domain logic out of Streamlit view modules when practical.

_Migration in progress_ (see `plans/2026-10-13-streamlit-to-react-fastapi-migration.md`): domain modules now live in `app/backend/` (flat imports, tests in `app/backend/tests/`); `scripts/` keeps only the Streamlit UI until it is removed. Run tests with `.venv/bin/python -m pytest`.

## Safe working rules

- Never test against the real `cameras/` directory or
  `data/picture_sorter.db`.
- For tests and verification, set `CURATION_CAMERAS_ROOT` and
  `CURATION_DATA_DIR` to temporary directories.
- Do not modify, move, or delete real camera frames or generated exports unless the user explicitly requests it.
- Keep direct label/golden state transactionally consistent; deliberate history belongs in Versions.
- When changing a domain invariant, update its canonical documentation and behavior tests in the same change.

## Context efficiency

Do not scan these by default:

- `.venv/`
- `cameras/*/unsorted/`
- `cameras/*/exports/`
- `app/**/__pycache__/`, `scripts/**/__pycache__/`
- historical plans or memory notes

Inspect them only when the task specifically requires their data or history. Prefer targeted searches and relevant modules over repository-wide reads.
