---
name: performance-and-ux-latency-improvements
description: Staged implementation plan for measuring and reducing unexplained waiting, grid latency, scoring cost, and repeated state reconstruction
status: complete
document_type: plan
last_updated: 2026-08-03
source_review: reviews/2026-08-03-performance-and-ux-latency-review
priority: high
implementation_mode: step-by-step
code_changed: true
tags:
  - plan
  - performance
  - streamlit
  - ux-latency
---

# Plan: Performance and UX latency improvements

> [!note] Clean-break addendum — 2026-08-03
> After this plan completed, the user authorized discarding metadata and all
> backwards compatibility. Phase 5's history/projection design was therefore
> replaced by direct SQLite state tables, and Phase 8's JSON ingest index was
> replaced by a SQLite frame catalog. See
> [[2026-08-03-sqlite-clean-break-and-storage-decision]].

> **Status — complete.** This plan turns [[2026-08-03-performance-and-ux-latency-review|the performance and UX latency review]] into independently implementable phases. Phases 0–9 have been executed; Phase 9 closed by measurement without a cache-format migration.

> **Implementation update — 2026-08-03.** Phase 0 instrumentation, tests, and the safe synthetic baseline are complete. Results are recorded in
> [[2026-08-03-phase-0-performance-baseline]].

> **Latest update — 2026-08-03.** Phase 3 bulk cache discovery, bounded writes, and neural batching are complete. Measurements and compatibility checks are in [[2026-08-03-phase-3-cache-and-embedding-batching]].

> **Phase 4 update — 2026-08-03.** Exact classical comparisons now execute
> concurrently, neural distances are vectorized, and decoded candidate vectors are streamed in bounded groups. See [[2026-08-03-phase-4-streamed-and-parallel-comparison]].

> **Phase 5 update — 2026-08-03.** Stress measurements selected materialized
> current-state tables. Atomic triggers, additive migration, and history-based recovery are complete and recorded in [[2026-08-03-phase-5-materialized-current-state]].

> **Phase 6 update — 2026-08-03.** One render-scoped data snapshot, explicit
> mutation invalidation, and bulk Status summaries are complete. See
> [[2026-08-03-phase-6-render-data-snapshots]].

> **Phase 7 update — 2026-08-03.** Thumbnail caches are explicitly bounded,
> retain encoded bytes instead of decoded PIL buffers, expose hit/miss
> diagnostics, and explain large-page cost in the grid. See
> [[2026-08-03-phase-7-thumbnail-and-grid-presentation]].

> **Phase 8 update — 2026-08-03.** Folder contents now stream through bounded
> hash-and-stage chunks, duplicate-index writes are atomic and checkpointed, and
> upload/folder imports expose live phases and counts. See
> [[2026-08-03-phase-8-streaming-ingest]].

> **Phase 9 update — 2026-08-03.** Result-cache serialization and persistence
> were measured from 48 to 1,000 frames. Compression saves storage but does not
> improve end-to-end latency, so the compatible JSON format remains unchanged.
> See [[2026-08-03-phase-9-result-serialization-decision]].

## Goal

Make waiting in the application both shorter and understandable from the user's perspective.

The work should:

- Identify actual elapsed time by phase before optimizing algorithms.
- Remove redundant database and history reconstruction from normal grid rendering.
- Keep the user informed through feature extraction, comparison, persistence, and grid preparation.
- Improve cold-cache embedding throughput without changing scoring semantics.
- Keep performance predictable as frame counts and append-only histories grow.
- Preserve all documented data-model invariants and existing user workflows.

## Guiding constraints

- Implement one phase at a time and verify it before starting the next phase.
- Do not test against the real `cameras/` directory or `data/picture_sorter.db`.
- Use temporary roots through `CURATION_CAMERAS_ROOT` and `CURATION_DATA_DIR`.
- Preserve append-only label, golden, delete, and mute history.
- Do not change scoring formulas or blend scoring methods during this work.
- Do not auto-compute scoring when entering a fresh ROI; the existing explicit Refresh decision remains in force.
- Preserve source-frame immutability.
- Prefer measured improvements over speculative caching.
- Each phase should be a separate reviewable change with its own verification record.

## Success criteria

The project should satisfy these outcomes when the complete plan is finished:

1. A developer diagnostics mode reports the main phases of a Classify rerun and score refresh.
2. A 24-card full grid render does not reload complete label, golden, or deletion histories per card.
3. A fragment rerun reads state only for the affected frame.
4. Score refresh never presents a completed progress bar while substantial comparison or persistence work remains unexplained.
5. Missing neural embeddings are computed in bounded batches.
6. Feature-cache writes use bounded transactions rather than one commit per frame.
7. Warm-cache scoring does not retain decoded grayscale data for the complete frame set unnecessarily.
8. Normal current-state reads do not require Python to replay an unbounded history for every UI render.
9. Performance changes preserve score results and domain behavior on a deterministic synthetic fixture.

## Baseline scenarios

Build a safe synthetic performance fixture before implementation. It should contain enough data to expose scaling behavior without using production data.

Recommended scenarios:

| Scenario | Frames | Classes | Goldens | Page size | History |
| --- | ---: | ---: | ---: | ---: | --- |
| Small interactive | 48 | 2 | 3 per class | 24 | One current action per frame |
| Medium grid | 300 | 2 | 5 per class | 24 and 96 | Several relabels per frame |
| Multi-class | 300 | 4 | 4 per class | 24 | Several golden add/remove events |
| History stress | 100 | 2 | 5 per class | 24 | Hundreds or thousands of historical state changes |
| Cold feature cache | 100–300 | 2 | 3 per class | 24 | No score-cache vectors |
| Warm feature cache | Same fixture | 2 | 3 per class | 24 | All vectors cached |

Record at least:

- Total elapsed time
- SQL query count by operation
- Rows fetched from history tables
- Frames and goldens processed
- Cache hits and misses by feature kind
- Time spent in each scoring method
- Result serialization and write time
- Thumbnail hits and misses
- Cards prepared

Exact performance thresholds should be set after the baseline is captured on the user's machine. Relative comparisons are more portable than fixed millisecond limits.

## Phase 0 — Establish safe performance measurement

### Implementation record — 2026-08-03

Implemented:

- Opt-in aggregate tracing in `scripts/perf.py`, controlled by
  `CURATION_PERF_DIAGNOSTICS`.
- Optional JSONL output through `CURATION_PERF_LOG`.
- A compact sidebar diagnostics table for the most recent view render.
- Timings for score discovery, feature preparation, cache lookup/commit, embedding calls, comparison by method, result serialization, cache hydration, filtering, thumbnails, and grid construction.
- Counters for database connections, state-history reads and rows, feature-cache hits/misses, frames, goldens, methods, payload bytes, thumbnails, and grid cards.
- `scripts/benchmark_performance.py`, which creates temporary storage before
  importing application modules and compares deterministic cold/warm classical score payloads.
- Isolated unit coverage for enabled/disabled tracing, aggregation, and JSONL output in `tests/test_perf.py`.
- Usage instructions in `README.md`.

Validation completed:

- All changed Python modules pass `py_compile` using the bundled Python runtime.
- `tests/test_perf.py` passes using the project `.venv`.
- The 48-frame cold/warm benchmark completed using temporary storage.
- Cold and warm serialized results matched exactly.
- Baseline measurements are recorded in
  `reviews/2026-08-03-phase-0-performance-baseline.md`.

### Purpose

Create trustworthy measurements before optimizing. This phase should not intentionally change scoring or UI behavior.

### Proposed changes

- Add a small timing utility based on `time.perf_counter()`.
- Make diagnostics explicitly opt-in, preferably through an environment setting or development-only sidebar expander.
- Record structured phase measurements rather than scattered print statements.
- Add counters for relevant workload sizes and cache behavior.
- Provide a deterministic synthetic fixture builder using temporary camera and data roots.
- Add a repeatable benchmark or profiling script that exercises domain functions without launching against production storage.

### Initial measurement points

- Application/view entry
- Camera, ROI, and frame discovery
- Current labels, goldens, deletes, and mutes
- Persistent result-cache load and deserialization
- Per-frame feature-cache lookup
- Classical feature extraction
- ResNet18 inference
- ResNet50 inference
- Per-method golden comparison
- Result serialization
- Result-cache write
- Filtering and sorting
- Thumbnail generation
- Grid construction
- Complete Classify render

### Likely files

- New `scripts/perf.py` or similarly narrow diagnostics module
- `scripts/classify.py`
- `scripts/view_classify/render.py`
- `scripts/view_classify/_grid.py`
- Test or benchmark files using temporary roots

### Verification gate

- Diagnostics are off by default.
- Enabling diagnostics produces one understandable record per operation or rerun.
- Measurements include workload counts, not only elapsed time.
- Synthetic runs never open or mutate production storage.
- Baseline results are recorded in a follow-up review note under `reviews/`.

Do not proceed to Phase 1 until the baseline can distinguish database-state loading, scoring, serialization, thumbnails, and grid construction.

## Phase 1 — Remove Classify grid N+1 state queries

### Implementation record — 2026-08-03

**Status: complete.** Full grid renders now use parent label, golden, and deleted
snapshots. Fragment-only reruns use three indexed point queries for the affected
frame. Classify also reuses its loaded label/golden snapshots when calculating
counts.

Measured on the same Phase 0 fixture:

- Grid state time: 130.6 ms → 5.8 ms (95.6% reduction).
- Database connections: 72 → 3.
- Label-history rows fetched: 10,896 → 454.
- Golden-history rows fetched: 144 → 6.

Nine automated tests pass. Streamlit's native app harness also verified relabel,
star, and delete-cascade interactions against a temporary 24-frame fixture.
Full results are recorded in
[[2026-08-03-phase-1-grid-state-query-optimization]].

### Purpose

Address the highest-confidence interactive bottleneck without changing persistence semantics.

### Proposed changes

#### Full app render

- Continue loading current labels and goldens once in `view_classify/render.py`.
- Load the deleted-frame set once.
- Pass these snapshots into `_grid.render_grid` and each `_card` during a full render.
- Remove complete-history calls from each card's normal full-render path.

#### Fragment rerender

- Add targeted state helpers for one frame:
  - `current_label_for_frame(camera, feature, frame)`
  - `current_golden_for_frame(camera, feature, frame)`
  - `is_frame_deleted(camera, frame)`
- Implement these as indexed queries that retrieve only the latest relevant row or rows.
- On a card fragment rerun, refresh only that card's state.
- Avoid calling `current_labels`, `current_goldens`, or `deleted_frames_of` from the fragment.

#### Query structure

- Confirm existing indexes support the targeted queries.
- Add narrowly scoped indexes only if query plans show they are needed.
- Avoid introducing a current-state table in this phase; first take the smaller, lower-risk query fix.

### Likely files

- `scripts/labels.py`
- `scripts/db.py`
- `scripts/view_classify/render.py`
- `scripts/view_classify/_grid.py`
- Focused state-query and UI behavior tests

### Behavior to preserve

- A class click immediately updates the card.
- A star click immediately updates the card.
- A delete or restore still triggers the required app-scope rerun.
- Top metrics may retain their existing fragment behavior unless deliberately changed later.
- Append-only history remains intact.

### Verification gate

- A full 24-card render performs a constant number of bulk state reads rather than state-history reads per card.
- A fragment click performs only targeted reads for one frame.
- Label, relabel, clear, star, unstar, delete, and restore behavior remains correct.
- Baseline comparison shows reduced query count and grid elapsed time.
- No production data is used.

This should be the first optimization phase implemented after measurement.

## Phase 2 — Make the entire score-refresh lifecycle visible

### Implementation record — 2026-08-03

**Status: complete.** Classify and Insights now show phase-aware status for
discovery, feature preparation, candidate comparison, persistence, and result
presentation. Classify completes the status only after grid construction.

`classify.refresh()` exposes typed progress events through a new callback while
preserving the original callback API. Errors produce an error status, and a
persistent-cache failure leaves valid session results available with a warning.

Eleven tests pass, including domain event sequencing, legacy callback
compatibility, cold/warm result equality, and a native Streamlit refresh that
requires completed status plus persisted results. Full validation is recorded in
[[2026-08-03-phase-2-score-refresh-progress]].

### Purpose

Eliminate unexplained waiting, especially after the existing vector progress reaches 100%.

### Proposed changes

- Replace the single progress callback with a typed or phase-aware progress reporter.
- Report these phases separately:
  1. Discovering frames and cache state
  2. Loading features and embedding missing frames
  3. Comparing candidates with goldens
  4. Serializing and saving results
  5. Preparing the visible grid
- Include current count, total count, and method/backbone where applicable.
- Keep completed phase information visible until the operation transitions to the next phase.
- Handle empty frame sets and zero-golden cases without division errors.
- Ensure an exception changes the status to an understandable error instead of leaving a spinner active.

### API direction

Prefer a neutral domain callback such as:

```python
progress_cb(phase="compare", done=i, total=n, detail="cpu")
```

The scoring module should not depend on Streamlit. The view translates domain progress events into `st.status`, `st.progress`, captions, or equivalent UI elements.

### Likely files

- `scripts/classify.py`
- `scripts/view_classify/render.py`
- Possibly `scripts/dedup.py` and `scripts/view_dedup.py` after the Classify behavior is proven

### Verification gate

- A cold-cache refresh identifies model and feature work.
- A warm-cache refresh visibly transitions into comparison work.
- Saving and grid preparation are not silent.
- The progress display does not claim completion before the refresh and immediate presentation work are complete.
- Scoring results match the pre-change deterministic fixture.

## Phase 3 — Batch cache discovery, feature writes, and neural inference

**Status: complete.** Classify now discovers cached feature kinds with bounded
multi-hash queries, persists newly derived rows with `executemany`, and performs
neural inference in configurable batches. Dedup uses the same shared cache
pipeline. Completed inference batches commit independently, and oversized model
batches retry recursively at smaller sizes.

On the 48-frame classical fixture, feature/cache preparation improved from
178.2 ms to 114.8 ms (35.6%) and persistence improved from 68.5 ms across 48
commits to 14.0 ms in one batch (79.5%). On eight in-memory images using CPU,
batch size eight improved ResNet-18 from 173.1 ms to 140.4 ms (1.23×) and
ResNet-50 from 448.9 ms to 349.1 ms (1.29×), with identical output in both runs.

### Purpose

Reduce cold-cache time for newly ingested images and newly created or changed ROIs.

### Proposed changes

#### Cache discovery

- Retrieve cached kinds for the frame set in bulk or in bounded groups.
- Determine missing classical features and embeddings before invoking models.
- Avoid one cache lookup per frame where a bounded multi-key query is practical.

#### Batched neural inference

- Add `embed_batch(cutouts, backbone, batch_size=...)` while keeping `embed()` as a compatibility wrapper if useful.
- Preprocess multiple images and stack them into one tensor.
- Run inference under `torch.inference_mode()`.
- Select conservative configurable batch sizes for CPU and CUDA.
- Keep memory bounded and provide a safe fallback if a batch cannot be processed.

#### Batched persistence

- Accumulate cache rows and write with `executemany`.
- Commit once per bounded batch.
- Preserve completed batches if a later batch fails.
- Share the cache-writing path between Classify and Dedup where practical.

### Likely files

- `scripts/embedding.py`
- `scripts/classify.py`
- `scripts/dedup.py`
- `scripts/db.py`
- `scripts/config.py` for conservative batch configuration

### Verification gate

- Batched embeddings are numerically equivalent to single-image embeddings within a defined tolerance.
- L2 normalization is preserved.
- Cache keys and invalidation behavior are unchanged.
- Interrupted runs retain completed cache batches without corrupt rows.
- Cold-cache elapsed time improves on the same synthetic workload.
- Peak memory remains bounded at the chosen batch size.

## Phase 4 — Stream warm classical scoring and vectorize comparisons

**Status: complete.** Exact SSIM was measured at 95.5% of warm classical
comparison time, so the approved decision path was to retain it unchanged and
parallelize independent candidate/reference pairs. Neural cosine distances use
matrix multiplication. Golden vectors remain resident while candidate vectors
are decoded, scored, and released in groups of 32.

On the 48-frame fixture, warm refresh improved from 977.8 ms to 461.6 ms
(52.8%) and comparison improved from 930.8 ms to 436.7 ms (53.1%). On a
192-frame memory fixture, incremental decoded-vector peak fell from 48.41 MiB
to 9.84 MiB (79.7%). Score-equivalence tests preserve every leaning and match
distances, margins, and novelty within `1e-6`.

### Purpose

Reduce warm-cache memory use and repeated Python-level comparison overhead without changing score semantics.

### Proposed changes

- Load and retain golden vectors once.
- Process candidate vectors in bounded batches rather than retaining `all_vecs` for every frame.
- Keep grayscale cache data in `uint8` until needed.
- Vectorize cosine-distance comparisons for each neural method using matrix multiplication.
- Vectorize histogram and MSE calculations where feasible.
- Treat SSIM separately; first measure its share of comparison time.
- Preserve nearest-golden-per-class behavior exactly.

### SSIM decision point

After measurement, choose one of:

1. Keep exact SSIM and parallelize or batch surrounding work.
2. Calculate SSIM only where it affects the CPU opinion, if an exact equivalence can be maintained.
3. Propose a scoring-method change in a separate methodology review.

Option 3 is explicitly outside this performance plan and requires user approval because it changes scoring semantics.

### Likely files

- `scripts/classify.py`
- `scripts/curation.py`
- Focused score-equivalence tests

### Verification gate

- Every fixture frame has the same leaning as before.
- Margins, novelty, and class distances match within an agreed numerical tolerance.
- Peak memory falls for medium and large fixtures.
- Warm-cache refresh time improves measurably.
- No scoring formula is changed.

## Phase 5 — Make current-state retrieval scale with current data

**Status: complete. Option B selected.** With 400,000 total history rows, full
Python replay took 681.4 ms and latest-row SQL took 75.8 ms, while production
materialized reads took 10.0 ms including four short-lived connections. The
same production reads took 9.3 ms with 40,000 history rows, demonstrating that
normal read cost now follows current cardinality rather than redundant history.

Four additive current-state tables are rebuilt once during schema-version-1
migration and maintained atomically by SQLite insert triggers. Append-only
histories remain authoritative. A public rebuild operation restores projections
from history; rebuilding a 400,000-row fixture took 101.6 ms.

### Purpose

Prevent normal UI reads from becoming slower merely because append-only history grows.

### Decision required after Phase 1 measurements

Choose between:

#### Option A — Latest-row SQL queries and bulk snapshots

- Use SQL window functions or grouped maximum IDs.
- Keep only the history tables.
- Lower migration risk, but potentially more work per bulk read.

#### Option B — Materialized current-state tables

- Add current label, current golden, current deleted, and current mute tables.
- Update history and current state in the same transaction.
- Keep history authoritative for audit and recovery.
- Add a rebuild operation that reconstructs current tables from history.
- Higher implementation cost, but the most predictable read performance.

Use measured history-stress results to select the option. Option B is preferred if history replay remains material after Phase 1.

### Required safeguards for Option B

- Migration is additive and recoverable.
- Rebuilding current state from history produces the same state.
- Writes to history and current state are atomic.
- Existing databases initialize without data loss.
- Domain invariants remain enforced.

### Likely files

- `scripts/db.py`
- `scripts/labels.py`
- Database migration and reconstruction tests
- Possibly delete/mute domain helpers

### Verification gate

- Current state matches a full replay of history for every fixture.
- Read time stays approximately stable as redundant historical events increase.
- Append-only history remains complete.
- Database initialization and upgrade are safe on a copied temporary database.

## Phase 6 — Reduce repeated filesystem, ROI, and summary work

**Status: complete.** Status-style data preparation on the 500-frame, 15-ROI
fixture improved from 1,205.7 ms to 56.3 ms (95.3%). Per-render database
connections fell from 81 to 4. Physical ROI reads, inbox directory scans, and
product-membership builds are each limited to one per render.

The cache exists only for the current render and cannot survive into a later
Streamlit rerun. Ingest, ROI saves, and product-label/golden changes also
invalidate affected entries immediately, which protects mutation callbacks and
nonstandard callers operating within an active render.

### Purpose

Remove smaller repeated costs across Classify, Status, and ROI editor reruns.

### Proposed changes

- Load frame lists and ROI definitions once per render and pass them downward.
- Add narrowly scoped caching only where ownership and invalidation are clear.
- Invalidate frame snapshots after ingest or camera creation.
- Invalidate ROI snapshots after create, edit, scope change, or delete.
- Add bulk feature summaries for Status.
- Calculate product membership once per view render.
- Avoid repeated `Path.stat()` calls for the same visible frame where practical.

### Likely files

- `scripts/datamodel.py`
- `scripts/view_status.py`
- `scripts/view_roi_editor/`
- `scripts/view_classify/render.py`
- `scripts/ui_common.py`

### Verification gate

- New images appear immediately after ingest.
- ROI edits immediately change crops and feature scope.
- Status counts remain correct after label and golden changes.
- Diagnostics show fewer repeated filesystem and ROI reads.

## Phase 7 — Bound thumbnail and large-grid presentation cost

**Status: complete.** The Classify thumbnail cache now stores immutable JPEG
payloads in a 256-entry LRU; ROI-editor data URIs use a separate 128-entry LRU.
Requests, hits, misses, and generation time are visible in performance traces.
File modification time and complete ROI geometry remain in every cache key.

On the paired 24/48/96-card synthetic workload, cold thumbnail preparation
remained within ±4%, warm retrieval improved by 82.6–84.1%, and the 96-thumbnail
retained payload estimate fell from 12.44 MB of decoded pixels to 0.21 MB of
encoded bytes. Streamlit backend grid preparation measured 180/288/544 ms respectively,
excluding browser paint. The app keeps 24 as the recommended default, displays
an in-progress grid-preparation caption, and explains the tradeoff at 48/96.
Virtualization was not added because the measured backend cost does not yet
justify its state and interaction complexity.

### Purpose

Keep presentation work and memory use controlled during long sessions.

### Proposed changes

- Set explicit bounds on thumbnail caches.
- Evaluate caching encoded JPEG bytes rather than PIL objects.
- Add thumbnail hit/miss timing.
- Keep 24 as the recommended page size.
- Add a visible warning or help text for 48/96-card pages if measurements confirm a significant cost.
- Evaluate lazy or virtualized rendering only if the earlier phases do not make large pages acceptable.

### Likely files

- `scripts/ui_common.py`
- `scripts/view_classify/_grid.py`
- ROI editor thumbnail callers

### Verification gate

- Thumbnail cache memory is bounded.
- Thumbnail appearance remains unchanged at normal page sizes.
- Changed ROIs do not show stale crops.
- Page changes and grid setting changes remain responsive.

## Phase 8 — Stream folder ingest with useful progress

**Status: complete.** Folder import retains only sorted path metadata plus a
1 MiB content chunk instead of preloading every file's bytes. Each source is
hashed while being staged to a temporary file in the destination directory;
duplicates and errors remove that exact temporary file, while unique frames are
atomically renamed into the immutable inbox. Uploads pass their existing
seekable objects instead of creating a second list of complete byte payloads.

The 48 × 1 MiB synthetic fixture reduced peak traced Python memory from 50.41 MB
to 2.24 MB (95.5%). Elapsed time changed from 514 ms to 549 ms (+6.7%) while
adding atomic staging, progress delivery, and index checkpoints. Across 12 MiB
and 96 MiB batches, peak memory stayed between 2.15 MB and 2.37 MB. Scanning,
hash-and-stage, commit, duplicate, error, and index-persistence phases now reach
the Streamlit status UI with live added/skipped/error counts.

### Purpose

Avoid holding a complete folder import in memory and explain ingest work to the user.

### Proposed changes

- Convert folder import from a preloaded byte list to incremental iteration.
- Report scanning, hashing, copying, duplicates, and errors.
- Persist the ingest index periodically or atomically at successful completion.
- Preserve filename sanitation and content-hash duplicate behavior.

### Likely files

- `scripts/ingest.py`
- `scripts/view_ingest.py`

### Verification gate

- Duplicate and naming behavior matches the existing implementation.
- Memory usage does not scale with total source-folder bytes.
- Partial errors are reported without discarding successful imports.
- Progress reflects the active ingest phase.

## Phase 9 — Evaluate result payload serialization

**Status: complete — no production format change.** Current JSON persistence
takes 7.6 ms for 48 frames/one method, 10.6 ms for 300 frames/three methods, and
21.5 ms for 1,000 frames/four classes/three methods. This is not a material share
of scoring latency. Compact JSON saves only 8.8–9.2%.

Zlib-compressed compact JSON saves 91.3–92.8% of payload bytes, but complete
serialize/save and load/deserialize latency is effectively unchanged at 48 and
300 frames and is 1.7 ms slower at 1,000 frames. Because `results_cache` holds
one replaceable derived row per camera/feature/ROI and the largest fixture is
0.55 MB, the absolute storage benefit does not justify a versioned reader,
migration/fallback branch, and additional failure modes now. The benchmark and
legacy-JSON compatibility tests remain available if real workloads grow.

### Purpose

Optimize result persistence only if measurements show it remains meaningful after higher-priority work.

### Decision rule

Do not implement this phase unless serialization plus result-cache writing represents a material portion of warm refresh time or database size.

### Possible changes

- Compact JSON representation
- Compressed JSON payload
- Binary serialization with an explicit version
- Normalized result rows if queryability is valuable

Any format change must include backward-compatible reading or a safe cache-miss fallback. Scored results are derived data and may be rebuilt, but a malformed old cache must never wedge the view.

### Verification gate

- Old payload behavior fails safely or remains readable.
- Round-trip results preserve all methods and distances.
- Measured savings justify the added complexity.

## Test strategy across all phases

### Domain equivalence

- Label and clear-label history
- Golden add, remove, and relabel behavior
- Deleted and restored frames
- Muted and unmuted frames
- Product-scoped and shared ROI frame sets
- Score cache invalidation after ROI changes
- Persistent result hydration and stale signatures

### Scoring equivalence

- Same frame ordering under every sort mode
- Same leaning per method
- Same margin and novelty within tolerance
- Same nearest distance for every represented class
- Goldens remain unscored references
- Zero- and one-class-golden cold-start behavior remains valid

### UI behavior

- Full grid render
- Card fragment rerender after label and star changes
- App rerender after delete and restore
- Page navigation and page-size changes
- Cached-result entry after server/session restart
- Explicit Refresh requirement for a fresh ROI
- Phase-aware progress for cold and warm refreshes

### Performance regression checks

- Query count per 24-card render
- Rows fetched per state operation
- Warm refresh elapsed time
- Cold embedding throughput
- Peak memory during scoring
- Thumbnail-generation count per page

## Documentation updates during implementation

For each completed phase:

- Update this plan's status or add a dated implementation note.
- Record measured before/after results in `reviews/`.
- Update `docs/current-project.md` if architecture or known limitations change.
- Update `docs/data-model.md` if current-state persistence is added.
- Update `docs/methodology.md` only if scoring semantics are deliberately changed in a separately approved task.

## Recommended step-by-step sequence

The proposed working sequence with the user is:

1. **Phase 0 — complete:** diagnostics, safe benchmark, and recorded baseline.
2. Review the baseline results together.
3. **Phase 1 — complete:** removed grid N+1 state reads and recorded validation.
4. **Phase 2 — complete:** full refresh progress lifecycle implemented and verified.
5. **Phase 3 — complete:** batched cache discovery, feature persistence, and neural inference.
6. **Phase 3 re-measurement — complete:** cold classical and both configured neural backbones validated.
7. **Phase 4 — complete:** exact parallel classical comparisons, vectorized neural distances, and bounded decoded vectors.
8. **Phase 5 — complete:** materialized current state selected, migrated, and verified.
9. **Phase 6 — complete:** render-scoped snapshots, mutation invalidation, and bulk Status summaries.
10. **Phase 7 — complete:** bounded encoded thumbnail caches, observable grid preparation, and measured page-size guidance.
11. **Phase 8 — complete:** bounded folder ingest, atomic/checkpointed index persistence, and phase-aware progress.
12. **Phase 9 — complete, no change:** serialization measured; compression rejected because it does not improve end-to-end latency and absolute payload size is modest.

## Out of scope

- Changing metric weights or removing SSIM without a separate methodology decision
- Blending CPU and neural opinions
- Automatically labeling frames
- Moving source images
- Introducing a distributed cache or external service
- Background scoring on entry to a fresh ROI
- Broad UI redesign unrelated to latency visibility

## Current checkpoint

Phases 0–9 are complete. The performance and UX-latency implementation plan is
closed. Future work should begin from a fresh measurement report if real camera,
frame, ROI, or history sizes expose a new dominant cost.
