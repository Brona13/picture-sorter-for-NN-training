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

## Update: merge done locally (branch `merge-attempt`, commit 5f92d3c)
- `origin/main` merged into the migration on a copy branch; 141 backend + 51 frontend tests pass. Not pushed yet.
- Kept from remote: `rois` SQLite table + v2→v3 migration (+ its test, now in `app/backend/tests`), ingest signature cleanup (no `target` arg), `engine.curation` shim removal, docs.
- Dropped: remote's Streamlit-only work (`session_keys`, `view_dedup` split, view smoke tests).
- **Real `cameras/*/rois.json` files:** the merge deletes them from git (as the remote did). They were restored on disk, untracked, because this machine's real `data/picture_sorter.db` is still schema v2 and the v3 migration backfills ROIs from those files on first open. Don't delete them before the real DB has been opened once with the new code (back up `data/` first).

## Update: pushed (user, 2026-10-13)
`origin/main` and `origin/react-fastapi` both at `da8e5c0` (the merge result). The migration is now on `main`; the remote's earlier Streamlit-side work is merged in history. Local `merge-attempt` branch can be deleted. Still open: browser click-through of the UI; back up `data/` + `cameras/` before first launching new code on the real v2 database (the v3 migration reads the restored, untracked `cameras/*/rois.json`).
