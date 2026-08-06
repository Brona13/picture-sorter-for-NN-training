---
name: phase-2-score-refresh-progress-2026-08-03
description: Validation of phase-aware progress across score discovery, features, comparison, persistence, and presentation
status: shipped
document_type: code-review
review_type: ux-performance-validation
review_date: 2026-08-03
last_updated: 2026-08-03
overall_risk: low
critical_findings: 0
high_findings: 0
medium_findings: 0
low_findings: 0
scope: phase-2-score-refresh-progress
code_changed: true
source_plan: plans/performance-and-ux-latency-improvements
baseline: reviews/2026-08-03-phase-0-performance-baseline
tags:
  - review
  - performance
  - progress
  - streamlit
  - ux-latency
---

# Phase 2 score-refresh progress

## Outcome

Score refresh now communicates its complete server-side lifecycle instead of presenting feature preparation as the whole operation.

The status remains active through:

1. Discovering frames and cache state
2. Preparing image features
3. Comparing candidates with golden references
4. Saving score results
5. Preparing results for display

It changes to **Scores refreshed** only after the Classify grid has been constructed. Insights uses the same progress component and completes after its matrices have been rendered.

## Motivation confirmed by baseline

The [[2026-08-03-phase-0-performance-baseline|Phase 0 baseline]] measured a 932.6 ms warm classical refresh, of which 884.5 ms—approximately 94.8%—was candidate comparison. The former bar tracked only the 37.1 ms feature phase. It could therefore show 100% while nearly all meaningful warm-cache work remained.

Phase 2 gives comparison its own progress phase and then explicitly covers persistence and presentation.

## Implementation

### Domain progress events

`classify.ProgressUpdate` carries:

- `phase`
- `done`
- `total`
- optional `detail`

`classify.refresh()` accepts a new `phase_progress_cb` while retaining the original two-argument `progress_cb`. Existing callers therefore remain compatible.

The domain module emits events before and after discovery, throughout per-frame feature preparation, and throughout candidate comparison. Comparison progress advances per candidate and identifies the active method set without multiplying UI updates by the number of methods.

### Shared Streamlit presentation

`ui_common.ScoringProgressUI` owns the status container and progress bar. It:

- Changes the status label when the phase changes.
- Resets the phase-specific bar with an accurate count.
- Displays enabled scoring methods as detail.
- Marks exceptions as errors.
- Preserves a persistent-cache warning while still allowing session results to render.
- Completes only when the caller confirms presentation is ready.

### Classify lifecycle

`view_classify/render.py` now keeps the progress controller returned by an explicit refresh. Persistence runs under its own phase, followed by `Preparing results for display`. Completion happens after filtering, supporting controls, thumbnails, and grid construction have executed.

### Insights lifecycle

`view_insights.py` uses the same discovery, feature, and comparison events. It then reports result presentation and completes after all method matrices are constructed.

## User-visible behavior

### Cold feature cache

The user sees feature preparation advance across frames before comparison begins. A new phase label and reset bar make it clear that completed feature extraction is not completed scoring.

### Warm feature cache

Feature preparation advances quickly, then the status visibly changes to candidate comparison—the dominant warm-cache operation found in Phase 0.

### Persistence and grid work

After comparison, the status reports saving and then display preparation. The UI no longer removes its progress indicator immediately before constructing the grid.

### Failures

A scoring exception changes the status to an error before propagating through Streamlit's normal error handling. A result-cache write failure does not discard valid session results; completion reports that the scores are session-only.

## Verification

Eleven automated tests pass.

Phase-specific tests verify:

- Discovery emits start and completion events.
- Feature progress covers every frame.
- Comparison progress covers every non-golden candidate.
- Enabled method detail is present.
- The legacy two-argument callback still receives its original per-frame updates.
- Cold and warm scoring payloads remain identical.
- A real Streamlit app refresh finishes with a completed `Scores refreshed` status.
- Persistent results exist before the completed UI state is asserted.

The Streamlit application test used eight generated images, temporary camera/database roots, CPU-only scoring, and the actual `scripts/app.py` widget flow. Production storage was not accessed.

## Non-goals

- No scoring formula changed.
- No embedding or cache-write batching was introduced.
- No background scoring was added.
- Entering a fresh ROI still requires an explicit Refresh click.
- Browser paint time cannot be measured server-side; completion is emitted after the grid's Streamlit elements have been constructed and queued.

## Next step

Phase 2 is complete. Phase 3 should batch cache discovery, neural inference, and feature-cache persistence. Its before/after measurements should separate model inference from SQLite transaction savings.
