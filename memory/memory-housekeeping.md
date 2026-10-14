---
name: memory-housekeeping
session_date: 2026-10-14
last_updated: 2026-10-14
description: Memory folder audit - front matter aligned for the Dataview index, notes renamed to short undated names, five dead links fixed
status: current
document_type: session-handoff
metadata:
  type: project
---

# Memory housekeeping (2026-10-14)

Commit `6701105`, pushed to `origin/main`. Docs and notes only; no code or version bump.

## Front matter
- Standard shape (what `_index.md` Dataview reads): `name`, `session_date`, `last_updated`, `description`, `metadata.type`; optional `status`, `document_type`.
- The three 2026-10-13 notes lacked `last_updated` and `metadata.type` (blank Type column). Fixed; `migration-push-state` marked `status: superseded` with a corrected description.
- `_index.md` and `MEMORY.md` deliberately have no `session_date`, so they stay out of the table.

## Renames (git mv, `name` = filename)
- `migration-push-state`, `ui-polish-and-windows`, `react-fastapi-migration`, `goldens-export-versioning-gpu`, `documentation-foundation`, `git-repo-connection`.
- Wikilinks and `MEMORY.md` links updated; no other references existed.

## Dead links (all 70 Markdown files scanned, none left)
- `docs/data-model.md`: `[[migration-v2-v3-rois]]` never existed; now points to `_migrate_v2_to_v3` in `app/backend/db.py`.
- `memory/streamlit-gotchas.md`: `[[todo-streamlit-use-container-width]]` never existed; link removed.
- `plans/classify-ui-tune.md`, `plans/persistent-grid-settings.md`: `../scripts/*.py` now `../app/backend/*.py` (line numbers dropped).

## Open / not done
- `todo-roi-image-fullwidth.md` still has no `status: pending` / `document_type: todo` (optional).
- Key order in front matter varies between older notes (cosmetic).
- Dataview table could gain a `status` column.

Naming preference: [[memory-note-naming]].
