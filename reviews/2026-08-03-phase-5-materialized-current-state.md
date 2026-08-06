---
name: phase-5-materialized-current-state-2026-08-03
description: Decision, migration, and stress validation for history-independent current-state reads
status: superseded
document_type: code-review
review_type: performance-and-migration-validation
review_date: 2026-08-03
last_updated: 2026-08-03
overall_risk: low
critical_findings: 0
high_findings: 0
medium_findings: 0
low_findings: 0
scope: phase-5-materialized-current-state
code_changed: true
superseded_by: reviews/2026-08-03-sqlite-clean-break-and-storage-decision
source_plan: plans/performance-and-ux-latency-improvements
baseline: reviews/2026-08-03-phase-1-grid-state-query-optimization
tags:
  - review
  - performance
  - sqlite
  - migration
  - current-state
---

# Phase 5 materialized current state

> [!warning] Superseded
> This report records the measured Phase 5 decision at that point in time. The
> later clean-break decision removed event histories, projections, triggers, and
> migration support. See [[2026-08-03-sqlite-clean-break-and-storage-decision]].

## Outcome

Phase 5 prevents normal state reads from slowing as append-only decision history grows. Materialized latest-row tables now serve label, golden, deletion, and deduplication-mute reads. History remains complete and authoritative.

The change is an additive, schema-versioned migration. Existing history rows are not modified or deleted.

## Decision benchmark

The isolated stress benchmark held current cardinality at 500 frames while increasing redundant events in each of four history tables.

### 40,000 total history rows

| Strategy | Median read time |
| --- | ---: |
| Full Python history replay | 58.4 ms |
| Latest-row SQL | 12.1 ms |
| Production materialized reads | 9.3 ms |

### 400,000 total history rows

| Strategy | Median read time |
| --- | ---: |
| Full Python history replay | 681.4 ms |
| Latest-row SQL | 75.8 ms |
| Production materialized reads | 10.0 ms |

Production measurement calls the four existing domain helpers, including their four short-lived SQLite connections. A single-connection materialized control measured 3.3 ms at 400,000 rows.

Full replay grew by approximately 11.7× and latest-row SQL by 6.3× when history grew tenfold. Production current-state time grew by only 0.7 ms, approximately 7.6%, within normal connection and scheduling variation. Option B was therefore selected.

## Data model

The derived tables are:

- `current_labels`, keyed by `(camera, feature, frame)`
- `current_goldens`, keyed by `(camera, feature, frame, class)`
- `current_deleted_frames`, keyed by `(camera, frame)`
- `current_dedup_mute`, keyed by `(camera, feature, frame)`

Each row stores the originating `history_id`. Cleared and inactive actions remain in the projection so it represents the actual latest row; read queries filter for active states.

## Atomic writes

SQLite `AFTER INSERT` triggers upsert the corresponding projection. The history insert and projection update participate in the caller's existing transaction. If the transaction rolls back, neither row remains.

Triggers update a projection only when the inserted history ID is greater than the currently projected ID. This matches the existing maximum-ID rule and also protects controlled imports that explicitly preserve older IDs.

The 400,000-row synthetic insertion completed in 18.3 seconds, about 45.8 microseconds per history action including trigger maintenance. Interactive writes are one or a few actions; bulk functions retain their existing transactions.

## Migration and recovery

Database schema version 1 creates the tables and triggers, then reconstructs current state from maximum history IDs inside an immediate transaction.

Migration properties:

- All schema additions are additive.
- Authoritative histories are read but never rewritten.
- The schema version advances only after a successful rebuild.
- A failed rebuild rolls back and retries on the next initialization.
- Concurrent initializers serialize through SQLite's write lock and recheck the version after acquiring it.

Rebuilding all projections from the 400,000-row fixture took 101.6 ms and produced 500 latest rows in each table. `db.rebuild_current_state()` exposes the same recovery operation for diagnostics or repair.

## Verification

Twenty-three automated tests pass. Phase 5 tests verify:

- History and projection inserts commit atomically.
- Rolling back a history write also rolls back its projection.
- Projection state follows maximum history ID.
- A simulated pre-versioned database upgrades and backfills correctly.
- History row counts are unchanged by migration.
- Corrupted projections rebuild to the expected full-replay state.
- Feature purge removes feature-scoped history and derived state together.
- Camera-wide deletion state correctly survives feature purge.
- Existing grid, progress, scoring-equivalence, cache, and diagnostics tests pass.

The standard temporary scoring benchmark also completed with byte-identical cold and warm payloads. Its simulated grid read fetched 48 current label rows and six current golden rows rather than 454 and six history rows.

## Operational note

The first application connection after this change performs the version-1 backfill once. The operation is instrumented as `db.current_state.migration_rebuild`, so diagnostics can explain the one-time
startup work. The 400,000-row synthetic backfill took approximately 102 ms; an actual database depends on storage and history size.

## Next step

Phase 6 should profile repeated filesystem frame lists, ROI loading,
product-membership calculation, and Status summaries before introducing
narrowly scoped caches with explicit invalidation.
