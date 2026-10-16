---
name: camera-tags-and-verdict-plan
description: v1.25.0 camera tags and New camera wizard, plus the agreed project-verdict design for v1.26.0-v1.27.0
session_date: 2026-10-16
last_updated: 2026-10-16
status: current
document_type: session-note
---

# Camera tags, New camera wizard (1.25.0) and the verdict plan

- Creating a camera was at the bottom of Ingest under Maintenance; it is now **New camera** on Overview (name, tags, then Ingest opens on it).
- Tags: `tags.py`, settings key `tags`; per camera; filter on Overview needs all selected tags.
- Full design of verdicts, progress indicators (including deleted and duplicate counts) and verdict-based export: `plans/project-verdict-plan.md`. Key choices: all OK = OK, all NG = NG, anything else a contradiction; automatic verdicts final; user decisions go stale when inputs change; export moves from goldens to verdicts.
- Unverified in a browser.
