---
name: phase-4-streamed-and-parallel-comparison-2026-08-03
description: Validation of exact parallel classical comparison, vectorized neural distances, and bounded decoded-vector memory
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
scope: phase-4-streamed-and-parallel-comparison
code_changed: true
source_plan: plans/performance-and-ux-latency-improvements
baseline: reviews/2026-08-03-phase-3-cache-and-embedding-batching
tags:
  - review
  - performance
  - comparison
  - ssim
  - memory
---

# Phase 4 streamed and parallel comparison

## Outcome

Phase 4 reduces the dominant warm-cache scoring delay without changing the scoring formula. Classical candidate/reference comparisons execute concurrently, neural cosine distances use matrix multiplication, and decoded candidate data is retained for only one bounded group at a time.

## SSIM decision

Additional instrumentation separated the three components of the CPU family on the 48-frame fixture:

| Component | Calls | Warm elapsed | Share of CPU comparison |
| --------- | ----: | -----------: | ----------------------: |
| Histogram |   252 |       4.6 ms |                    0.5% |
| MSE       |   252 |      32.5 ms |                    3.4% |
| SSIM      |   252 |     924.6 ms |                   95.5% |

The plan's first SSIM option was selected: keep exact SSIM and parallelize independent comparisons. Calculating SSIM selectively or changing its formula would alter methodology and was not necessary to obtain a material improvement.

Histogram and MSE retain their exact scalar implementations. Their combined share was too small to justify introducing a separate approximate or numerically reordered vectorized path.

## Implementation

### Exact classical concurrency

Each candidate/reference CPU distance still calls the existing histogram, MSE, SSIM, and weighted-combination functions. A bounded `ThreadPoolExecutor` evaluates independent pairs concurrently and reduces them to the nearest golden per class in deterministic input order.

The default is four workers. Controlled runs showed one worker was substantially slower, while eight workers introduced contention and was slower than four on this machine.

### Neural matrix comparisons

For each backbone and class, candidate and golden embeddings are stacked into matrices. One matrix multiplication produces cosine similarities for the batch; the existing `(1 - similarity) / 2` distance transformation and `[0, 1]` clamp are preserved.

### Bounded decoded vectors

Feature preparation retains compact cache blobs. Golden vectors are decoded once, while candidates are decoded and compared in groups of 32. Each candidate group is explicitly released before the next is constructed.

Cold feature derivation uses the same group size, bounding loaded ROI cutouts as well as warm-cache decoded grayscale arrays.

The defaults in `scripts/config.py` are:

```python
SCORING_VECTOR_BATCH_SIZE = 32
CLASSICAL_COMPARISON_WORKERS = 4
```

## Performance measurements

The standard deterministic fixture contains 48 frames, six goldens, 200
requested history events, 160-pixel synthetic source images, and classical-only scoring. All storage is temporary.

| Measurement | Phase 3 | Phase 4 | Improvement |
| --- | ---: | ---: | ---: |
| Cold refresh | 1,048.2 ms | 623.0 ms | 40.6% |
| Cold comparison | 906.3 ms | 494.8 ms | 45.4% |
| Warm refresh | 977.8 ms | 461.6 ms | 52.8% |
| Warm comparison | 930.8 ms | 436.7 ms | 53.1% |

Threaded timing varies with operating-system scheduling and concurrent machine load. A separate four-worker confirmation measured a 493.1 ms warm refresh; both final runs remain approximately twice as fast as the Phase 3 warm result.

### Worker selection

| Workers | Warm refresh | Warm comparison |
| ---: | ---: | ---: |
| 1 | 1,108.3 ms | 1,084.3 ms |
| 4 | 461.6–493.1 ms | 436.7–470.9 ms |
| 8 | 482.2 ms | 457.4 ms |

Four is retained as the conservative default. Deployments can tune this value after measurement on their hardware.

## Memory measurement

The memory fixture contains 192 frames and six retained golden vectors. It measures incremental Python allocations after the common compact cache has been prepared, isolating decoded feature data.

| Strategy | Peak decoded-vector allocation |
| --- | ---: |
| Retain every decoded frame | 48.405 MiB |
| Six goldens plus batches of 32 | 9.838 MiB |
| Reduction | 79.7% |

The retained compact SQLite blobs are common to both strategies and excluded from this isolated comparison.

## Score equivalence and verification

Eighteen automated tests pass. New Phase 4 coverage compares batched output with the original scalar reference across deterministic CPU and ResNet-18 fixtures:

- Every candidate leaning is identical.
- Per-class distances, margin, and novelty agree within `1e-6`.
- Candidate order is preserved.
- Goldens remain unscored references.
- Candidate decoding occurs in bounded groups and releases each group.
- Existing Phase 0–3 diagnostics, progress, cache, and grid tests continue to pass.

The standard cold/warm benchmark also verifies byte-identical serialized
results between cold and warm cache states.

## Remaining considerations

- Exact SSIM remains the main comparison cost; further large gains would likely require a methodology decision, native batch implementation, or process-level parallelism with higher complexity.
- Four worker threads are created per active refresh. If several users refresh simultaneously, deployment-level worker tuning may be appropriate.
- Compact cached blobs still scale with frame count, but the much larger decoded float32 grayscale working set is bounded.

## Next step

Phase 5 should stress append-only label, golden, delete, and mute histories at larger sizes before choosing between improved latest-row queries and materialized current-state tables.
