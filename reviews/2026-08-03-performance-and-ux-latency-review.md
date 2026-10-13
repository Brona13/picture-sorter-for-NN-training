---
name: performance-and-ux-latency-review-2026-08-03
description: Static audit of performance bottlenecks, unexplained waiting, progress reporting, and grid refresh latency
status: implemented
document_type: code-review
review_type: performance-and-ux
review_date: 2026-08-03
last_updated: 2026-08-11
overall_risk: high
critical_findings: 2
high_findings: 4
medium_findings: 5
low_findings: 1
scope: active-python-code
code_changed: false
tags:
  - review
  - performance
  - streamlit
  - ux-latency
---

# Performance and UX latency review

## Executive summary

This is a static performance and user-perceived latency audit of the active Python code. No application code was changed, and no performance test was run against production camera data or the production database.

The slowdown is most likely cumulative rather than caused by one isolated regression. The two strongest findings are:

1. The Classify grid performs many redundant full-history database queries while rendering.
2. The scoring progress bar tracks feature loading and extraction, but not the potentially expensive comparison, persistence, and page-rendering work that follows it.

The most likely user-visible cost order is:

`grid database replay > uncached embedding inference > CPU golden comparisons/SSIM > thumbnail and Streamlit rendering > result serialization`

The exact order between embedding and grid work depends on whether the feature cache is cold or warm.

## Scope and method

Reviewed active modules under `scripts/`, excluding `scripts/_retired/`. The review traced these user flows:

- Application and view reruns
- New-image and new-ROI scoring
- Persistent score-cache hydration
- Classify filtering and grid rendering
- Label, golden, delete, and mute state retrieval
- Dedup embedding and clustering
- ROI editor rendering
- Status summaries
- Folder ingest

Severity describes expected effect on user waiting time and how broadly the issue affects normal usage. Findings are based on code structure and algorithmic behavior; instrumentation is recommended before using exact timing claims.

## Findings and recommendations

### Critical — Classify grid has an N+1 database-query problem

Every displayed card reloads the complete label history and complete golden history for the selected feature:

- `scripts/view_classify/_grid.py:242-246`
- `scripts/labels.py:86-99`
- `scripts/labels.py:124-142`

Each card also reloads and reconstructs the entire camera-wide deletion history:

- `scripts/view_classify/_grid.py:301-303`
- `scripts/db.py:328-341`

At the default 24 cards, a full render can therefore perform approximately:

- 24 complete label-history queries
- 24 complete golden-history queries
- 24 complete deletion-history queries
- The normal page-level queries in addition

At 96 cards, this can become roughly 288 redundant history queries. These functions read matching append-only rows and reconstruct current state in Python, so the cost grows with both page size and accumulated editing history.

This is the strongest explanation for grid refreshes becoming progressively slower after continued app use.

#### Recommendation

- Load labels, goldens, and deleted frames once in the parent render.
- Pass current per-frame state into cards during a full render.
- On a fragment rerun, query only the affected frame using dedicated `current_label_for_frame`, `current_golden_for_frame`, and `is_deleted` operations.
- Longer term, maintain materialized current-state tables while preserving the append-only tables as history.

Expected effect: potentially an order-of-magnitude reduction in grid-render database work, depending on history size and page size.

### Critical — The progress bar finishes before scoring actually finishes

The progress callback is updated only while cached vectors are loaded or missing vectors are calculated:

- `scripts/classify.py:180-190`

After the bar reaches 100%, the app still compares every non-golden frame with the goldens for every available method:

- `scripts/classify.py:192-203`
- `scripts/classify.py:132-150`

The approximate comparison workload is:

`candidate frames × golden frames × scoring methods`

The CPU method performs histogram, MSE, and SSIM calculations for every comparison. SSIM operates on standardized 256 × 256 arrays. Increasing the number of goldens can therefore slow a refresh even when every embedding is already cached.

After comparison, the application still:

- Builds golden and frame signatures
- Serializes the complete result to JSON
- Writes the result to SQLite
- Filters and sorts the results
- Generates or retrieves thumbnails
- Constructs and sends the Streamlit grid

The progress element is removed directly after `classify.refresh()` returns at `scripts/view_classify/render.py:185-206`; page construction continues without a visible explanation.

#### Recommendation

Replace the single-phase bar with a multi-phase status display:

1. Preparing frame list
2. Loading cached features and embedding new frames
3. Comparing frames with references
4. Saving results
5. Preparing the grid

The comparison phase should report candidates completed, not only vectors loaded. Keep a visible `Preparing grid…` state until page preparation is complete. This directly addresses the reported experience of a completed progress bar followed by unexplained waiting.

### High — Neural embeddings are calculated one image at a time

Each missing embedding calls the neural model with a batch of one:

- `scripts/embedding.py:109-119`

Classification calculates both configured backbones by default:

- `scripts/config.py:60-63`

Consequences:

- GPU utilization is likely poor because images are submitted individually.
- CPU execution repeatedly pays preprocessing and model-call overhead.
- ResNet18 and ResNet50 each preprocess every new cutout independently.
- Models are cached, but inference execution is not batched.

#### Recommendation

- Fetch cache metadata for the complete frame set first.
- Collect missing images into bounded batches, such as 16–64 depending on available memory.
- Run one batched forward pass per backbone.
- Report the active backbone and images completed.
- Consider making the second backbone opt-in if its additional review value does not justify its cost.

Expected effect: a large improvement during new-image and new-ROI passes, especially when CUDA is available.

### High — Feature-cache writes commit once per frame

Classification commits cached features inside `_get_vectors`, which is invoked per frame:

- `scripts/classify.py:86-107`

Dedup follows the same pattern:

- `scripts/dedup.py:120-141`

SQLite WAL reduces contention, but hundreds of small transactions remain materially more expensive than batched writes.

#### Recommendation

- Compute a bounded batch of features.
- Insert cache rows with `executemany`.
- Commit once per batch or once per refresh.
- Choose batch sizes that preserve useful partial progress if a run is interrupted.

### High — Warm classical scoring still decodes and retains all gray images

On every score refresh, cached PNG-encoded grayscale arrays are loaded from SQLite, decoded, converted to float32, and retained in `all_vecs` for the complete feature:

- `scripts/classify.py:109-116`
- `scripts/classify.py:180-203`

A 256 × 256 float32 grayscale array occupies approximately 256 KiB. One thousand frames therefore require roughly 250 MiB for grayscale arrays alone, excluding embeddings, histograms, result objects, Python overhead, and thumbnail caches.

#### Recommendation

- Keep golden vectors resident.
- Stream candidate vectors through comparison in bounded batches.
- Keep grayscale data as `uint8` until a calculation requires floating-point values.
- If CPU scoring is a secondary opinion, allow it to be disabled during neural-only refreshes.
- Measure whether SSIM contributes enough useful ranking information to justify repeated pairwise evaluation.

### High — Current-state reads replay complete append-only histories

The current-state functions select all historical rows and determine the latest state in Python:

- `scripts/labels.py:86-99`
- `scripts/labels.py:124-142`
- `scripts/db.py:328-341`
- `scripts/db.py:397-411`

Ordinary reads therefore become slower as classifications, relabels, deletes, restores, mutes, and unmutes accumulate—even if the image count stays constant.

#### Recommendation

Preserve append-only history, but add one of:

- Materialized current-state tables updated in the same transaction
- SQL queries selecting the maximum row ID per entity
- Window-function queries using `ROW_NUMBER()`
- Periodic snapshots with only later events replayed

Materialized current-state tables should provide the most predictable interactive performance.

### Medium — Full filesystem enumeration repeats on Streamlit reruns

`list_unsorted()` enumerates and sorts the complete image directory whenever called:

- `scripts/datamodel.py:69-80`

Several flows call frame-selection functions repeatedly during one render. Product-scoped frame selection also reloads labels and goldens:

- `scripts/datamodel.py:196-219`
- `scripts/datamodel.py:222-230`

ROI definitions are likewise repeatedly read and parsed through helpers that call `load_rois()`.

#### Recommendation

- Introduce run-scoped or short-lived cached snapshots for frame names and ROI definitions.
- Invalidate frame caches after ingest and ROI caches after edits.
- Pass already-loaded structures through helpers instead of reopening them.
- Avoid broad long-lived caching without explicit invalidation rules.

### Medium — Large grid pages create many Streamlit elements

The grid supports pages of up to 96 cards at `scripts/view_classify/_grid.py:22-23`. Each card contains an image, HTML, captions, containers, columns, and multiple buttons. Even with cached thumbnails, Python reconstructs this element tree and Streamlit serializes and sends it to the browser.

#### Recommendation

- Keep 24 as the practical default and mark 48/96 as potentially slow.
- Consider lazy or virtualized rendering for large pages.
- Continue using fragment reruns for card-local actions, while removing their full-history queries.
- Display `Preparing N cards…` during page construction.
- Measure server-side render time separately from browser paint time.

### Medium — Thumbnail caching can consume substantial memory

`cutout_thumb` uses Streamlit data caching:

- `scripts/ui_common.py:242-251`

Every unique image, ROI, and modification-time combination creates a distinct cache key. Creating or changing ROIs creates new keys while older entries can remain cached.

#### Recommendation

- Set explicit `max_entries` and, if useful, TTL values.
- Consider caching compressed JPEG bytes rather than PIL objects.
- Record thumbnail cache hits, misses, and generation time.
- Establish an explicit cache-invalidation strategy for ROI changes.

### Medium — Folder ingest loads the complete batch into memory

Folder import reads every recognized image into a list before ingestion:

- `scripts/ingest.py:164-183`

The UI supplies a generic spinner rather than file-level progress.

#### Recommendation

- Stream files one at a time or in bounded batches.
- Hash and copy incrementally.
- Report scanning, hashing, copying, duplicates, and errors separately.
- Save the ingest index periodically during very large imports.

### Medium — Status and ROI views reconstruct state per feature

Status loops over every ROI and calls count and version functions separately:

- `scripts/view_status.py:29-57`

Each `labels.counts()` reloads labels, goldens, frame scope, ROI data, and potentially product-classification state. The ROI editor similarly calculates product membership repeatedly:

- `scripts/view_roi_editor/_roi_list.py:89-104`

#### Recommendation

- Add bulk summary queries for every feature of a camera.
- Load current labels and goldens once, then group them in memory.
- Calculate product membership once per render.
- Reuse already-loaded ROI and frame data throughout the view.

### Low — Results use verbose JSON serialization on every refresh

The complete scored result is converted into nested dictionaries and JSON:

- `scripts/classify.py:209-244`
- `scripts/view_classify/render.py:198-202`

For many frames, classes, and methods, this can produce a sizable payload and a noticeable post-scoring pause.

#### Recommendation

- Instrument serialization and database-write duration first.
- If material, evaluate compressed JSON, a compact binary format, or normalized result rows.
- Address grid queries and scoring behavior before optimizing serialization.

## Recommended implementation order

1. Add lightweight timing instrumentation before changing algorithms.
2. Eliminate per-card full-history queries.
3. Extend progress reporting across comparison, persistence, and rendering phases.
4. Batch embedding inference and cache writes.
5. Stop replaying complete append-only histories for normal current-state reads.
6. Stream classical candidate scoring instead of retaining all decoded gray images.
7. Cache filesystem and ROI enumeration with explicit invalidation.
8. Bound thumbnail caches and assess compact result serialization.

## Recommended performance instrumentation

Measure the following phases independently:

- Application/module startup
- Camera, frame, and ROI discovery
- Current-state database loading
- Persistent score-result hydration and deserialization
- Feature-cache lookup
- Classical feature extraction
- ResNet18 preprocessing and inference
- ResNet50 preprocessing and inference
- Golden comparison per scoring method
- Result serialization
- Result database write
- Filtering and sorting
- Thumbnail cache hits and misses
- Grid element construction
- Complete Streamlit rerun duration

Each measurement should include workload context:

- Number of applicable frames
- Number of missing feature vectors
- Goldens per class
- Enabled methods
- Grid page size
- Label, golden, delete, and mute history-row counts
- Thumbnail hits and misses
- Neural device

Use `time.perf_counter()` for elapsed time. Initially, write concise structured records to a local development log or an opt-in diagnostics panel; avoid rendering detailed timing output during every normal interaction.

## User-facing progress model

A useful progress display should distinguish cold-cache work from warm-cache work. Suggested phases and messages:

| Phase | Example message | Work represented |
| --- | --- | --- |
| Discovery | Preparing 1,240 frames | Files, scope, hashes, cache lookup |
| Features | Embedding ResNet50: 320/1,240 | Missing embeddings or classical features |
| Comparison | Comparing frames: 800/1,215 | Distances to current goldens |
| Persistence | Saving score results | Serialization and SQLite write |
| Presentation | Preparing 24 grid cards | Filters, sorting, thumbnails, UI construction |

For a warm cache, the feature phase may finish almost immediately while comparison still takes meaningful time. The UI should make that distinction explicit.

## Conclusion

The first implementation should not begin with neural-model changes. The highest-confidence interactive slowdown is the Classify grid repeatedly loading complete histories for every card. Fixing that query pattern and exposing the full refresh lifecycle should produce the clearest immediate improvement in both responsiveness and user understanding.

Batching embeddings and cache writes is the next major opportunity for cold-cache runs. Current-state materialization and bounded candidate scoring will keep the application responsive as both the frame collection and its append-only history grow.
