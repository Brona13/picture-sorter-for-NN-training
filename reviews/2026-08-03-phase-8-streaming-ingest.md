---
name: phase-8-streaming-ingest-2026-08-03
description: Validation of bounded folder ingest, atomic duplicate indexing, and phase-aware import progress
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
scope: phase-8-streaming-ingest
code_changed: true
source_plan: plans/performance-and-ux-latency-improvements
baseline: reviews/2026-08-03-performance-and-ux-latency-review
tags:
  - review
  - performance
  - ingest
  - streaming
  - progress
---

# Phase 8 streaming ingest

## Outcome

Folder import no longer retains the complete batch payload in memory before ingest begins. Image contents flow through a fixed 1 MiB buffer into an atomic staging file while SHA-256 is calculated. Users now see which ingest phase is active, which file is being processed, and running added/duplicate/error counts.

Exact duplicate behavior, sanitized names, collision suffixes, non-recursive folder selection, source-frame immutability, and partial-success reporting are preserved.

## Baseline

The safe baseline created 48 unique 1 MiB `.jpg` files under a temporary source folder. The former `ingest_folder()` built a list of `(name, path.read_bytes())` for every recognized file before calling the ingest loop.

| Measurement | Baseline |
| --- | ---: |
| Source payload | 50.33 MB |
| Peak traced Python memory | 50.41 MB |
| Elapsed time | 514.3 ms |
| Progress events | 0 |

Peak Python allocation therefore followed the sum of all source-file bytes. The app displayed only an indeterminate spinner during the complete operation.

## Implementation

### Bounded hash-and-stage pipeline

Folder scanning retains sorted `Path` metadata to preserve deterministic import and collision naming order, but it never loads a file with `read_bytes()`. Each path is opened and consumed in 1 MiB chunks. The same pass:

1. Updates the SHA-256 digest.
2. Writes the chunk to a uniquely named temporary file inside the destination.
3. Emits throttled byte progress.

An empty file produces its existing error. An exact duplicate deletes only its temporary staging file. A unique file is atomically renamed to the sanitized, collision-safe destination name. The source path is never modified.

Uploaded files now pass their existing seekable Streamlit objects to the same pipeline, avoiding the former second complete in-memory list created by `getvalue()`.

### Recoverable index persistence

The ingest index is serialized to a unique sibling temporary file and atomically replaces `ingest_index.json`. Long batches checkpoint after each 25 successful additions and save once more at normal completion.

This narrows the amount of successful work that can be absent from the derived index after an interrupted process. The index remains rebuildable from the immutable inbox. Index rebuild hashing now also uses bounded chunks.

### User-visible phases

The presentation-neutral `IngestProgress` callback reports:

- Folder scanning
- Hashing and atomic staging
- Unique-frame commit
- Duplicate detection
- Per-file errors while continuing
- Duplicate-index persistence

The Streamlit view translates these into one status and progress bar. It includes the current filename/file number plus live added, duplicate, and error totals. The existing post-rerun success, duplicate details, and error report remain.

### Diagnostics

Performance traces now separate scanning, hash-and-stage, commit, and index-save time. Counters include files/bytes hashed, bytes staged and committed, unique files, duplicates, and errors.

## Before-and-after result

| Measurement, 48 × 1 MiB | Before | After | Change |
| --- | ---: | ---: | ---: |
| Peak traced Python memory | 50.41 MB | 2.24 MB | 95.5% lower |
| Elapsed time | 514.3 ms | 548.6 ms | 6.7% higher |
| Progress events | 0 | 244 | Phase and file progress added |

The small elapsed-time increase pays for atomic staging, UI progress delivery, and checkpointed index persistence. The principal Phase 8 objective was removing batch-size-dependent memory and unexplained waiting, not changing SHA-256 cost.

## Scaling check

| Batch payload | Peak traced Python memory | Elapsed time |
| ---: | ---: | ---: |
| 12.58 MB | 2.15 MB | 143.3 ms |
| 50.33 MB | 2.24 MB | 548.6 ms |
| 100.66 MB | 2.37 MB | 1,114.0 ms |

An eightfold increase in total payload from the smallest to largest fixture increased peak Python allocation by about 10.5%, rather than eightfold. The small growth comes from path/index metadata; content memory remains chunk-bounded.

## Verification

Thirty-eight automated tests pass. Phase 8 coverage verifies:

- Bytes and seekable file objects share identical ingest semantics.
- Filename sanitation and `_1` collision suffixing are unchanged.
- Exact duplicates within and across batches are skipped.
- Empty files remain errors.
- Folder import does not call `Path.read_bytes()`.
- A source disappearing after scan is reported while later files still import.
- Staging files are removed after both successful and duplicate paths.
- Index JSON is valid and no index temporary siblings remain.
- A 26-file batch performs one checkpoint plus the final index save.
- Existing render-snapshot invalidation still exposes newly ingested frames.
- Streamlit progress text exposes the active domain phase and running counts.
- Completion summaries retain partial-error counts.

Every benchmark and test redirects camera/data storage to temporary directories. Production camera folders and the project database were not accessed.

## Reproduction

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_ingest.py
.\.venv\Scripts\python.exe scripts\benchmark_ingest.py --files 12
.\.venv\Scripts\python.exe scripts\benchmark_ingest.py --files 96
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

## Next step

Phase 9 is conditional. Measure result serialization time and stored payload size first. If serialization and result-cache writes are not a material share of warm refresh latency or database growth, close the phase without changing the cache format.
