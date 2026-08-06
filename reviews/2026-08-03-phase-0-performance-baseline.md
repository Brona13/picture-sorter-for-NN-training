---
name: phase-0-performance-baseline-2026-08-03
description: Synthetic cold/warm classical scoring and Classify grid state-read baseline captured before performance optimization
status: current
document_type: code-review
review_type: performance-baseline
review_date: 2026-08-03
last_updated: 2026-08-03
overall_risk: high
critical_findings: 2
high_findings: 1
medium_findings: 0
low_findings: 0
scope: phase-0-synthetic-baseline
code_changed: false
source_plan: plans/performance-and-ux-latency-improvements
tags:
  - review
  - performance
  - baseline
  - streamlit
---

# Phase 0 performance baseline

## Outcome

The synthetic baseline confirms the two critical findings from [[2026-08-03-performance-and-ux-latency-review|the original performance review]]:

1. Warm classical refresh time is dominated by candidate-to-golden comparison after cached features have loaded.
2. The current 24-card grid state pattern creates 72 database connections and repeatedly scans the same append-only histories.

This benchmark was captured before Phase 1 optimization using the project `.venv` and temporary storage created by `TemporaryDirectory`. It did not read or modify the production cameras or database.

## Fixture

| Property | Value |
| --- | ---: |
| Frames | 48 |
| Image dimensions | 160 × 160 |
| Classes | 2 |
| Goldens | 6 total |
| Candidates scored | 42 |
| Requested superseded history events | 200 |
| Active scoring methods | CPU classical only |
| Visible cards simulated | 24 |
| Storage | Temporary camera root and SQLite database |

Neural scoring was deliberately disabled for this Phase 0 baseline. Neural batching will receive a separate controlled baseline in Phase 3.

## Cold and warm scoring results

| Measurement | Cold cache | Warm cache |
| --- | ---: | ---: |
| Total refresh + serialize/deserialize | 1,119.6 ms | 932.6 ms |
| Feature phase | 178.2 ms | 37.1 ms |
| Comparison phase | 915.3 ms | 884.5 ms |
| Discovery | 7.0 ms | 7.0 ms |
| Result serialization | 0.3 ms | 0.3 ms |
| Gray-cache decoding | 35.3 ms | 32.5 ms |
| Feature-cache commits | 48 calls / 68.5 ms | 0 calls |
| Feature-kind hits | 0 | 96 |
| Feature-kind misses | 96 | 0 |

Cold and warm serialized score payloads were byte-identical. Instrumentation did not alter the deterministic result.

### Interpretation

- Candidate comparison consumed approximately **81.8%** of the cold run.
- Candidate comparison consumed approximately **94.8%** of the warm run.
- A fully warm feature cache saved about 187 ms overall, but it did not materially reduce the dominant comparison phase.
- The progress bar currently tracks the feature loop and therefore represents only about 4% of this warm refresh. The user can see it complete while nearly 885 ms of comparison is still executing even in this small CPU-only fixture.
- Serialization is negligible in this workload and should remain low priority.
- Per-frame commits are measurable in a cold run: 48 commits consumed 68.5 ms in aggregate.

## Simulated Classify grid state reads

The benchmark reproduced the present `_card` behavior for 24 visible cards without launching Streamlit. Each card requested the full current labels, goldens, and deleted-frame state.

| Measurement | Result |
| --- | ---: |
| Elapsed state-read time | 130.6 ms |
| Database connections | 72 |
| Label-state reads | 24 |
| Golden-state reads | 24 |
| Deleted-state reads | 24 |
| Label-history rows fetched in aggregate | 10,896 |
| Golden-history rows fetched in aggregate | 144 |

The fixture contained 454 label-history rows. The grid fetched all 454 rows once for every visible card: `454 × 24 = 10,896` rows. This is direct evidence of the N+1 pattern described in the original review.

The 130.6 ms measurement excludes thumbnail work, Streamlit element construction, message serialization, and browser paint. It is only redundant state retrieval on a small local fixture. Production impact will grow with accumulated history and larger page sizes.

## Priority confirmed by measurement

### Critical — Remove per-card history replay

Proceed with Phase 1 first. A full render should load current state once, while fragment reruns should query only the affected frame.

Baseline targets for the same 24-card fixture after Phase 1:

- Reduce state-related database connections from 72 to a small constant number.
- Reduce label-history rows fetched from 10,896 to one bulk snapshot of the relevant state.
- Preserve all label, golden, delete, and fragment behavior.

### Critical — Show comparison as a distinct progress phase

Proceed with Phase 2 after the query fix. Warm-cache comparison clearly dominates refresh time but is invisible to the current progress callback.

### High — Batch feature-cache commits

Retain the Phase 3 recommendation. Cold-cache commits accounted for 68.5 ms across 48 frames. Batching should reduce this component, though it will not address the dominant CPU comparison cost.

## Commands and validation

Executed with the project environment:

```powershell
. .\.venv\Scripts\Activate.ps1
python -m unittest tests.test_perf -v
python scripts\benchmark_performance.py
```

Validation result:

- Three diagnostics tests passed.
- Cold and warm result payloads matched exactly.
- Benchmark storage was temporary and deleted on exit.
- No production storage was accessed.

## Next step

Phase 0 is complete. The next implementation unit is **Phase 1 — Remove Classify grid N+1 state queries**. The measurements above are the before-state against which that change should be evaluated.
