---
name: phase-1-grid-state-query-optimization-2026-08-03
description: Before-and-after validation of bulk full-grid state snapshots and targeted fragment queries
status: shipped
document_type: code-review
review_type: performance-validation
review_date: 2026-08-03
last_updated: 2026-08-03
overall_risk: low
critical_findings: 0
high_findings: 0
medium_findings: 0
low_findings: 0
scope: phase-1-grid-state-queries
code_changed: true
source_plan: plans/performance-and-ux-latency-improvements
baseline: reviews/2026-08-03-phase-0-performance-baseline
tags:
  - review
  - performance
  - validation
  - streamlit
---

# Phase 1 grid state-query optimization

## Outcome

Phase 1 removed the Classify grid's N+1 full-history reads while preserving card fragment behavior.

An ordinary full grid render now uses label, golden, and deletion snapshots loaded once by the parent. A fragment-only card rerun uses indexed latest-state queries for only the affected frame.

## Implementation

### Bulk state on full renders

`scripts/view_classify/render.py` loads current labels and goldens once and reuses them when calculating counts. It also passes the already-loaded deleted-frame set into the grid.

`scripts/view_classify/_grid.py` marks the initial grid construction with a `ContextVar`. Cards rendered within that context use the parent snapshots and do not open card-level database connections.

The context marker is local to the current execution context. A later Streamlit fragment rerun executes outside it, which distinguishes fragment refreshes without relying on Streamlit's private runtime API.

### Targeted state on fragment reruns

Added indexed latest-state helpers:

- `labels.current_label_for_frame(camera, feature, frame)`
- `labels.current_golden_for_frame(camera, feature, frame)`
- `db.is_frame_deleted(camera, frame)`

These queries use the existing lookup indexes and return at most the current row needed by one card. Append-only history remains unchanged.

### Reused state for metrics

`labels.counts()` accepts optional label and golden snapshots. Existing callers retain the original behavior; Classify avoids loading both histories a second time during the same render.

## Before-and-after benchmark

The same deterministic fixture and benchmark parameters from [[2026-08-03-phase-0-performance-baseline|Phase 0]] were used:

- 48 frames
- 454 label-history rows
- 6 golden-history rows
- 24 simulated visible cards
- Temporary camera and database roots

| Grid state measurement | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Elapsed state-read time | 130.6 ms | 5.8 ms | 95.6% |
| Database connections | 72 | 3 | 95.8% |
| Label-state reads | 24 | 1 | 95.8% |
| Golden-state reads | 24 | 1 | 95.8% |
| Deleted-state reads | 24 | 1 | 95.8% |
| Label-history rows fetched | 10,896 | 454 | 95.8% |
| Golden-history rows fetched | 144 | 6 | 95.8% |

The remaining three connections are the intentional bulk label, golden, and deleted-state snapshots. The benchmark excludes thumbnails and Streamlit/browser presentation work, as before.

Scoring time varied within normal run-to-run noise and was not targeted by this phase. Cold and warm score payloads continued to match exactly.

## Verification

### Automated tests

Nine tests passed:

- Latest label lookup matches bulk state and handles cleared labels.
- Latest golden lookup matches bulk state across add/remove actions.
- Latest delete lookup handles delete and restore actions.
- Targeted reads report one returned history row rather than feature-wide history.
- Full-grid card state uses snapshots without database reads.
- Fragment card state performs exactly three targeted database reads.
- Phase 0 tracing behavior and JSONL output remain valid.

### Streamlit application flow

Streamlit's native application test harness ran the real `scripts/app.py` against a temporary 24-frame fixture. It verified:

1. Classify rendered with no application exceptions.
2. Relabeling a normal frame updated its current label through a fragment rerun.
3. Starring that frame created the correct golden state through a fragment rerun.
4. Deleting the frame triggered the app rerun, removed it from the visible grid, and cleared its label and golden state.

The temporary server and fixture were removed after verification. Production storage was not accessed.

## Compatibility and invariants

- Append-only histories are preserved.
- No database migration was required.
- Existing indexes support all new point queries.
- Source frames remain immutable.
- Golden/label consistency and delete cascade behavior are unchanged.
- Existing callers of `labels.counts()` remain compatible.

## Next step

Phase 1 is complete. Phase 2 should make discovery, feature loading, comparison, persistence, and grid preparation visible as separate user-facing progress phases. The Phase 0 baseline showed that comparison accounts for approximately 95% of a warm classical refresh in the synthetic fixture.
