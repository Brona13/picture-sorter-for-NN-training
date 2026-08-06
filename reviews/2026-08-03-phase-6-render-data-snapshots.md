---
name: phase-6-render-data-snapshots-2026-08-03
description: Validation of render-scoped filesystem and ROI snapshots plus bulk Status summaries
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
scope: phase-6-render-data-snapshots
code_changed: true
source_plan: plans/performance-and-ux-latency-improvements
baseline: reviews/2026-08-03-performance-and-ux-latency-review
tags:
  - review
  - performance
  - filesystem
  - status
  - caching
---

# Phase 6 render data snapshots

## Outcome

Phase 6 removes repeated filesystem, ROI, product-scope, and summary work within one Streamlit render. The cache lifetime is exactly one camera/view render, so it cannot serve stale data to a later rerun.

Status receives the largest measured improvement, while Classify and the ROI editor reuse the same snapshot mechanism for their repeated frame and ROI reads.

## Baseline

The safe synthetic benchmark mirrors Status data preparation with:

- 500 frame paths
- One four-class product-classification ROI
- Twelve product-specific quality ROIs
- Two shared ROIs
- Fifteen ROI rows total
- Materialized label and golden state
- One version for each quality ROI

Before Phase 6, one median data-preparation pass took 1,205.7 ms. Across five passes it made:

- 270 `load_rois()` calls
- 110 `list_unsorted()` calls
- 105 `frames_of_product()` calls
- 75 `frames_for_feature()` calls
- 405 SQLite connections

That is 54 ROI loads, 22 inbox listings, 21 product-frame calculations, and 81 database connections per render.

## Implementation

### Render-scoped snapshots

`datamodel.render_snapshot()` stores values in a `ContextVar` for one render.
It memoizes:

- Camera enumeration
- Inbox image paths
- ROI definitions
- Product membership
- Per-product frame lists
- Per-feature frame lists

Nested use shares the same snapshot. Leaving the context discards every cached value; there is no process-global or time-based cache to become stale across Streamlit reruns.

The snapshot begins before sidebar product resolution and remains active through the selected view.

### Explicit invalidation

Even within an active render, mutation paths invalidate dependent entries:

- Successful ingest invalidates inbox, product, and feature frame snapshots.
- ROI create, edit, scope change, or deletion invalidates ROI and derived frame scopes.
- Label, bulk-label, golden, and un-golden writes invalidate product membership.
- Camera directory creation invalidates camera enumeration.

This permits callbacks or tests to read their new state immediately without waiting for the expected Streamlit rerun.

### Bulk Status summaries

Status now loads label and golden state for every displayed feature with one SQLite connection. Version count and active-version number use one grouped query instead of loading every version row separately for each ROI.

Class vocabulary comes directly from the already-loaded ROI definitions.
Product membership is constructed once and reused across all product-specific and shared features.

### Reused frame metadata

The ROI editor reads its selected background frame's modification time once and passes it to every ROI thumbnail, rather than calling `Path.stat()` per card.

## Before-and-after result

| Measurement per render | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Median Status data preparation | 1,205.7 ms | 56.3 ms | 95.3% |
| SQLite connections | 81 | 4 | 95.1% |
| Physical ROI file reads | 54 | 1 | 98.1% |
| Inbox directory scans | 22 | 1 | 95.5% |
| Product-membership builds | 21 | 1 | 95.2% |

The after measurement recorded 42 snapshot hits per render. Logical helper calls remain in place for readable domain code, but repeated calls return the current render's snapshot.

## Verification

Twenty-seven automated tests pass. Phase 6 coverage verifies:

- Repeated frame and ROI reads perform one physical operation in a render.
- A successful ingest is visible immediately in the active snapshot.
- Saving ROI definitions immediately replaces the cached ROI set.
- A product-label change invalidates and recalculates product membership.
- Bulk label and golden snapshots match the individual domain helpers.
- Bulk version counts and active numbers match stored versions.
- Status bulk summaries reflect subsequent label and golden changes.
- The existing Streamlit application, scoring progress, state migration, comparison equivalence, and cache tests still pass.

All fixtures used temporary camera and database roots. Production images and the project database were not accessed.

## Diagnostics

New counters make the remaining behavior visible:

- `filesystem.camera_scans`
- `filesystem.unsorted_scans`
- `roi.file_reads`
- `product.membership_builds`
- `render_snapshot.hits` and `render_snapshot.misses`

Corresponding timing spans cover camera listing, inbox listing, and ROI loading.

## Next step

Phase 7 should measure thumbnail generation, cache memory, and 24/48/96-card grid presentation before selecting cache bounds or user-facing page-size guidance.
