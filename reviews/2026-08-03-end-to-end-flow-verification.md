---
name: end-to-end-flow-verification-2026-08-03
description: Regression and live-app verification after the missing-goldens-table startup failure
status: passed
document_type: code-review
review_type: end-to-end-verification
review_date: 2026-08-03
last_updated: 2026-08-03
overall_risk: low
critical_findings: 0
high_findings: 1
medium_findings: 0
low_findings: 0
scope: complete-user-flow
code_changed: true
source_review: reviews/2026-08-03-sqlite-clean-break-and-storage-decision
tags:
  - review
  - testing
  - end-to-end
  - sqlite
  - streamlit
---

# End-to-end flow verification

## Reported failure

The app displayed `no such table: goldens` after the clean database reset.

## Root cause

Streamlit was already running when the database was removed. The earlier database
module cached only the initialized path. A later connection recreated an empty
SQLite file at the same path and incorrectly skipped schema initialization because
the path still matched the in-memory cache.

The path cache has been removed. Every connection now checks
`PRAGMA user_version`; a new empty database is initialized immediately, while an
incompatible non-empty database raises the explicit reset error. A dedicated test
deletes the database behind a live module and proves the next connection recreates
schema version 2 with the `frames` table.

## Isolated complete-flow test

`tests/test_end_to_end_flow.py` uses temporary camera and data roots. It exercises:

1. Camera directory creation
2. Ten-image streamed folder ingest
3. SQLite frame catalog creation
4. Schema/version/table verification, including `goldens`
5. ROI creation
6. Labels and per-class golden marks
7. Label/golden invariant verification
8. Soft delete and restore
9. Dedup mute and unmute
10. Classical feature extraction and candidate scoring
11. Version freeze
12. Working-state mutation
13. Version revert
14. ROI-cutout export and file verification
15. Streamlit rendering of Ingest, ROI Editor, Dedup, Classify, Insights, Versions, and Status
16. Explicit Classify refresh, progress completion, and result-cache persistence

The test never reads or modifies the configured project cameras or database.

## Live-app verification

The already-running Streamlit application was tested against the active project
database and `pekat-cam3`:

- Active database: schema version 2
- Cataloged frames: 702 across the project at inspection time
- `goldens` query: successful
- Status: rendered
- Ingest: rendered
- ROI Editor: rendered with the saved product ROI
- Dedup: rendered
- Classify: rendered with 289 in-scope frames and an empty golden state
- Insights: rendered
- Versions: rendered
- Browser console errors: none

No real labels, goldens, versions, clusters, or files were created during the live
browser check. Expensive scoring and clustering were exercised only in temporary
storage.

## Final result

The full automated suite passes **41 tests**. The reported missing-table failure is
covered by both schema-replacement regression testing and the complete-flow test.

## Related documents

- [[2026-08-03-sqlite-clean-break-and-storage-decision|SQLite clean-break decision]]
- [[data-model|Current data model]]
