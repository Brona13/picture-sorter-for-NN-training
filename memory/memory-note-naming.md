---
name: memory-note-naming
session_date: 2026-10-14
last_updated: 2026-10-14
description: Name memory files with a short descriptive slug, no date; the date lives in front matter
metadata:
  type: feedback
---

Memory note filenames are short and descriptive with **no date** (e.g. `react-fastapi-migration`, not `2026-10-13-...` or `session-2026-...`). Set `name` in front matter equal to the filename without `.md`.

**Why:** the date is already stored in `session_date` / `last_updated`, so repeating it in the filename is redundant. This overrides the `yyyy-mm-dd-topic` convention in the global CLAUDE.md for this project's `memory/` folder.

**How to apply:** when saving a session or creating any memory note here, pick a short topic slug, put the date only in front matter, and add the entry to `MEMORY.md`. Applied in [[memory-housekeeping]].
