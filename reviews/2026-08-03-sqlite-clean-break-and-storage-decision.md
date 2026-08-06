---
name: sqlite-clean-break-and-storage-decision-2026-08-03
description: Clean-schema implementation report and measured JSON-versus-SQLite storage decisions
status: implemented
document_type: code-review
review_type: architecture-performance-follow-up
review_date: 2026-08-03
last_updated: 2026-08-03
overall_risk: medium
critical_findings: 0
high_findings: 1
medium_findings: 2
low_findings: 2
scope: persistence-clean-break
code_changed: true
source_review: reviews/2026-08-03-performance-and-ux-latency-review
source_plan: plans/performance-and-ux-latency-improvements
schema_version: 2
tags:
  - review
  - performance
  - sqlite
  - persistence
  - clean-break
---

# SQLite clean break and storage decision

## Outcome

The application now uses a deliberately incompatible schema version 2. Routine state is stored once in direct keyed SQLite tables. Event histories, materialized `current_*` projections, synchronization triggers, migration/rebuild code, retired Sort scripts, the manifest module, and the JSON ingest index have been removed.

Source images, `rois.json`, and generated exports are outside this schema reset and remain untouched.

## Measured decision

The isolated benchmark uses temporary directories and synthetic data.

### Append/projection versus direct state

At 50,000 edits resolving to 5,000 current rows:

| Design | Write time | Database size |
| --- | ---: | ---: |
| Append row + projection trigger | 139.400 ms | 3,395,584 bytes |
| Direct keyed UPSERT | 73.963 ms | 532,480 bytes |

Direct state was 46.9% faster to write and 84.3% smaller in this fixture. It also removes trigger and migration complexity. Explicit Versions remain the only intentional history mechanism.

### ROI definitions

| ROI count | JSON load | SQLite load |
| ---: | ---: | ---: |
| 15 | 0.134 ms | 0.392 ms |
| 100 | 0.251 ms | 0.535 ms |
| 500 | 0.873 ms | 1.203 ms |

`rois.json` remains. It is faster at the measured sizes, easy to inspect and edit, and already read once per render snapshot. Moving it would add coupling without a response-time benefit.

### Ingest catalog

At 20,000 frame records:

| Lookup | Median |
| --- | ---: |
| Load complete JSON index | 19.032 ms |
| Indexed SQLite point lookup | 0.386 ms |

The ingest catalog moved to SQLite. Duplicate checks now use the `(camera, hash)` index and catalog commits are checkpointed during large batches.

## Storage decisions

### Moved to SQLite

- Frame filename/content-hash/original-name catalog
- Current labels
- Current golden marks
- Current soft-deletion set
- Current dedup-mute set
- Existing settings, Versions, feature caches, result caches, scatter cache, and cluster snapshots

### Kept as files

- Source images: filesystem-native immutable inputs
- `rois.json`: small, human-readable configuration with faster measured loads
- Version exports: generated image-folder artifacts
- Optional performance JSONL: write-only diagnostics, never application state

### JSON inside SQLite

Version summaries and derived result payloads remain serialized blobs inside SQLite. They are loaded as whole records, are not used for indexed filtering, and prior measurements found compression latency-neutral. Splitting them into relational rows would not improve the observed user wait.

## Removed code and compatibility

- Additive schema migration and history-rebuild paths
- `current_labels`, `current_goldens`, `current_deleted_frames`, and `current_dedup_mute`
- Latest-row synchronization triggers
- Clear/remove/restore/unmute event rows
- Old scored-result optional-field fallback
- Old scoring progress callback
- `scripts/manifest.py`
- Retired `rank.py`, `undo.py`, and `view_sort.py`
- JSON ingest-index read/write helpers
- Selected/rejected cutout-directory helpers

## Recommendations by severity

### High — reset incompatible metadata before normal use (completed)

The existing schema-1 database cannot be opened by schema 2. Run the explicit reset after confirming that losing labels, goldens, Versions, and caches is acceptable:

```powershell
python scripts/reset_database.py --yes
```

The command preserves `cameras/<camera>/unsorted/`, every `rois.json`, and exports. Reingest or rebuild the frame catalog afterward; embeddings and scores will be recalculated on demand.

The project database was reset after verification. Two explicitly identified old
database backups were also removed under the user's clean-break authorization.
The fresh database reports schema version 2, twelve application tables, and zero
triggers. This removed the only recovery copies of the discarded metadata.

### Medium — treat manual source-folder edits as a catalog maintenance event

The application treats `unsorted/` as immutable. If files are added, replaced, or removed outside ingest, use the Ingest view's **Rebuild frame catalog** action. Automatic full reconciliation on every render would reintroduce an expensive directory scan and hash pass.

### Medium — continue measuring real user waits after the reset

Keep performance diagnostics opt-in and compare cold versus warm traces after representative reingest. The database redesign removes write amplification and index-file parsing, but embedding inference, thumbnail preparation, and browser grid layout can still dominate different flows.

### Low — keep `rois.json` unless scale changes materially

Reconsider SQLite ROI storage only if ROI count grows by orders of magnitude, multi-writer editing appears, or indexed ROI queries become necessary.

### Low — keep diagnostics JSONL out of the camera data model

Performance JSONL is appropriate as an optional append-only log because the application never reads it. Store it at an explicit diagnostic path and rotate or delete it independently.

## Verification

- The final suite passed 41 tests, including explicit clean-schema, live-process replacement, and complete-flow tests.
- New tests cover absence of projection tables/triggers, rejection of schema 1, reset preservation boundaries, SQLite catalog persistence, and label/golden transactional consistency.
- All test and benchmark fixtures use temporary camera and data roots.

## Related documents

- [[2026-08-03-performance-and-ux-latency-review|Original performance review]]
- [[2026-08-03-phase-5-materialized-current-state|Superseded Phase 5 decision]]
- [[data-model|Current data model]]
- [[performance-and-ux-latency-improvements|Implementation plan]]
