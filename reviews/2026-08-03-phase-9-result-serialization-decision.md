---
name: phase-9-result-serialization-decision-2026-08-03
description: Decision record retaining compatible JSON after measuring result-cache latency, size, and compression candidates
status: closed-no-change
document_type: code-review
review_type: performance-validation
review_date: 2026-08-03
last_updated: 2026-08-03
overall_risk: low
critical_findings: 0
high_findings: 0
medium_findings: 0
low_findings: 0
scope: phase-9-result-serialization
code_changed: true
production_format_changed: false
source_plan: plans/performance-and-ux-latency-improvements
baseline: reviews/2026-08-03-performance-and-ux-latency-review
tags:
  - review
  - performance
  - serialization
  - sqlite
  - decision-record
---

# Phase 9 result serialization decision

## Decision

Keep the existing compatible JSON result-cache format unchanged.

Serialization and SQLite persistence are not a material part of the measured refresh lifecycle. Zlib compression substantially reduces bytes, but it does not improve end-to-end persistence or hydration latency and the absolute uncompressed payload remains modest. A format marker, dual reader, migration/fallback logic, and additional corruption modes are not justified by the present workload.

This closes Phase 9 and the performance/UX-latency implementation plan.

## Measurement fixture

The safe benchmark creates deterministic `FrameScore` objects directly in
memory and uses a temporary SQLite database. It covers:

| Scenario | Frames | Classes | Methods | Intended scale |
| --- | ---: | ---: | ---: | --- |
| Interactive | 48 | 2 | 1 | Current classical baseline shape |
| Medium | 300 | 2 | 3 | Classical plus two neural opinions |
| Large multi-class | 1,000 | 4 | 3 | Product-style class vocabulary at larger scale |

Every timing is the median of 15 repetitions. Database measurements include the current short-lived connection and commit behavior.

## Current-format result

| Scenario      | JSON payload | Serialize | SQLite save | Complete persistence | SQLite load | Deserialize | Complete hydration |
| ------------- | -----------: | --------: | ----------: | -------------------: | ----------: | ----------: | -----------------: |
| 48 / 2 / 1    |       8.9 KB |   0.14 ms |     7.46 ms |              7.60 ms |     1.74 ms |     0.11 ms |            1.85 ms |
| 300 / 2 / 3   |     133.4 KB |   1.96 ms |     8.62 ms |             10.58 ms |     1.87 ms |     1.71 ms |            3.58 ms |
| 1,000 / 4 / 3 |     552.1 KB |   9.41 ms |    12.14 ms |             21.55 ms |     2.64 ms |     7.55 ms |           10.19 ms |

The Phase 4 48-frame warm refresh measured 461.6 ms. The 7.60 ms persistence path is about 1.6% of that total, confirming the original Phase 9 decision rule is not met for the representative interactive workload.

## Candidate comparison

### Compact JSON

Removing optional JSON whitespace saves only 8.8–9.2%. Encoding latency is essentially unchanged, so compact JSON alone is not worth even a minor format stability change.

### Zlib-compressed compact JSON

| Scenario | Current bytes | Compressed bytes | Size reduction | Current persistence | Compressed persistence | Current hydration | Compressed hydration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 48 / 2 / 1 | 8.9 KB | 0.75 KB | 91.6% | 7.60 ms | 7.46 ms | 1.85 ms | 1.88 ms |
| 300 / 2 / 3 | 133.4 KB | 9.6 KB | 92.8% | 10.58 ms | 10.76 ms | 3.58 ms | 3.63 ms |
| 1,000 / 4 / 3 | 552.1 KB | 47.8 KB | 91.3% | 21.55 ms | 23.20 ms | 10.19 ms | 10.26 ms |

Compression is effectively latency-neutral for the small and medium cases and 7.7% slower on large-result persistence. Hydration is slightly slower in every scenario. SQLite commit cost dominates the small result; at larger sizes, saved write time is offset by compression work.

The database primary key permits only one result row per
`(camera, feature, roi_key)`. At 1,000 frames the current row is about 0.55 MB, so even the 91% relative reduction is not presently an operational storage problem. Result rows are derived and replaceable rather than authoritative data.

## Compatibility verification

The production serializer and reader were not modified. New tests verify:

- Golden and candidate rows survive a byte-stable serialize/deserialize cycle.
- Per-method distances, leaning, margin, and novelty are preserved.
- Older JSON rows without `per_method` remain valid golden rows.
- Older method rows without `novelty` retain the existing `0.0` fallback.
- The benchmark's legacy and compressed candidates reconstruct equivalent `FrameScore` values.

Forty automated tests pass. The recurring Streamlit warning about replacing `st.components.v1.html` is pre-existing and unrelated to result persistence.

## Reproduction

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_result_serialization.py
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Both commands operate without production camera or database access; the
benchmark owns and removes its temporary database.

## Revisit trigger

Reopen this decision only if diagnostics or database inspection shows one of:

- Result persistence repeatedly exceeds 5% of refresh time.
- Cache hydration becomes visible during normal view entry.
- Result-cache rows, rather than feature vectors or histories, become a material share of database storage.
- Typical features grow substantially beyond the measured 1,000-frame,
  four-class, three-method case.

If reopened, prefer a small magic/version prefix plus compressed JSON and retain legacy JSON fallback. Normalized rows or an opaque binary object format remain unjustified unless queryability or cross-language consumption becomes a real requirement.
