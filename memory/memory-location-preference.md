---
name: memory-location-preference
session_date: 2026-07-08
last_updated: 2026-07-15
description: Keep project memory inside the project memory/ folder, not ~/.claude, for portability
metadata:
  type: feedback
---

The user wants **all memory kept in this project's `memory/` folder** (with a `MEMORY.md` index), rather than the machine-specific `~/.claude/.../memory` location, so that moving the project to another computer loses nothing.

**Why:** portability — the project may be moved between machines.
**How to apply:** write/read memory files here (this folder). It's also an Obsidian vault, so markdown + `[[wikilinks]]` render natively.
