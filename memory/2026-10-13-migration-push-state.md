---
name: migration-push-state
description: Git state after the React+FastAPI migration was pushed (2026-10-13); nothing merged yet
session_date: 2026-10-13
---

# Migration push state (2026-10-13)

- The user pushed local `main` (15 migration commits) themselves. It landed as the remote branch **`origin/react-fastapi`**. `origin/main` is unchanged at `a5710bf`.
- Local `main` and `origin/main` have **diverged** (ahead 15 / behind 15). No rebase, merge or force-push has been done.
- The remote main holds ~16 commits not present locally: Streamlit `session_keys` registry, `view_dedup` package split, view smoke tests, and a **schema change moving ROIs from `rois.json` into a SQLite `rois` table** (v2→v3 migration, `tests/test_rois_migration.py`).

## To combine the two
1. `git fetch origin && git switch -c merge-attempt main && git rebase origin/main` (abort with `git rebase --abort`).
2. Expect conflicts: remote edits files under `scripts/` and `tests/` that the migration deleted.
3. Port the ROI-table change and migration into `app/backend` (`db.py`, `datamodel.py`) plus its tests; the API/tests currently assume `rois.json`.
4. The user pushes themselves; give commands rather than pushing.
