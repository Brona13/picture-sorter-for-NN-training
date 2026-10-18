---
name: plan-file-location
session_date: 2026-07-29
last_updated: 2026-07-29
description: Save plan files in this project's plans/ folder, not just claude's global plans scratchpad
metadata:
  type: feedback
---

Every plan approved via ExitPlanMode must also be saved to this project's `plans/` folder (as a markdown file, kebab-case name matching the feature — see `plans/classify-and-versioning.md`, `plans/multi-product-hierarchy.md`, etc. for the pattern). Claude's global plan file at `~/.claude/plans/<name>.md` gets overwritten as plan mode is re-entered within a session, so it's not a durable record.

**Why:** the user wants plans to travel with the project (same reasoning as [[memory-location-preference]]). During a session where multiple plans get approved back-to-back, the global scratchpad only retains the most recent one — earlier plans are lost unless mirrored to `plans/`.

**How to apply:** when writing a plan file during plan mode, also write it (or a cleaned-up copy) to `plans/<feature-slug>.md` before or right after ExitPlanMode. If the plan bundles several small items, name it after the theme (e.g. `plans/classify-ui-tune.md`). If it's a single meaningful feature, name it after the feature (e.g. `plans/insights-view.md`, `plans/auto-assign-by-leaning.md`, `plans/persistent-scored-results.md`). Include a `> **Status — shipped & verified (YYYY-MM-DD).**` callout at the top when the work is complete, matching the pattern in `classify-and-versioning.md`.
