---
name: current-project
description: Authoritative snapshot of the current purpose, architecture, capabilities, limitations, and open work
status: current
document_type: project-status
last_updated: 2026-10-16
---

# Current project

This is the authoritative snapshot of the project’s present state.

Use it to answer:

- What is the tool for?
- How does the current workflow operate?
- What has already been implemented?
- How is the active code organized?
- What limitations and open work remain?

Historical plans and memory notes explain how the project reached this state, but they do not override this document or the active code.

## Purpose

The tool helps a human prepare compact, reliable training datasets for camera-based vision classification.

It addresses two related problems:

1. Large camera batches contain many redundant, nearly identical frames.
2. Incorrect labels can contaminate downstream classifier training.

The machine assists by comparing ROI cutouts with trusted labeled references. The human remains responsible for product and quality labels.

The tool does not train the final classifier. It prepares data for a separate training system.

## Current workflow

```text
Ingest frames
    ↓
Define camera ROIs
    ↓
Classify product, when the camera has multiple products
    ↓
Classify quality within the relevant product and ROI
    ↓
Mark trusted labeled frames as goldens
    ↓
Refresh and compare scoring-method opinions
    ↓
Review uncertain, unusual, or disagreeing frames
    ↓
Freeze a version
    ↓
Export training-ready class folders
```

## Current hierarchy

The current data hierarchy is:

```text
Camera → Product → Feature/ROI → Frame label
```

Product is optional:

- Cameras without a product-classification ROI use a flat camera/feature flow.
- Cameras with a `role="classify"` ROI first assign frames to product classes.
- Product-specific quality features see only their product’s frames.
- Shared features can apply one ROI and one metadata set to several products.

See [[data-model]] for the canonical entities and invariants.

## Implemented capabilities

### Cameras and tags

- Cameras are created on the Overview page (**New camera** wizard: name, tags, then straight to Ingest); the Ingest page no longer has a create form (v1.25.0)
- Tags per camera (`tags.py`, `settings` key `tags`, `GET /api/tags`, `GET/PUT /api/cameras/{camera}/tags`, `tags` in `/api/overview` and in `POST /api/cameras`); case-insensitive, at most 20 tags of 40 characters; Overview filters by tags with combined logic: each chip cycles off → required (✓) → excluded (✕), and a camera is shown when it has every required tag and none of the excluded ones (v1.28.0) (`TagEditor.tsx`, `OverviewView.tsx`)
- The **New camera** form lays name, tags and the two buttons on one line across the page (wrapping on narrow windows)
- The app remembers what you were working on, in this browser's `localStorage` (`lastSession.ts`, keys `picturesorter.*`): the last camera, the product and ROI per camera, and the last page (the root `/` opens it instead of the Overview). A refresh or server restart therefore resumes there; a remembered camera, product or ROI that no longer exists falls back to the first one (v1.30.0). It is per browser, not per server

### Ingest

- Multi-file upload through the web UI (staged to disk, ingested by a background job)
- Import from a local folder path
- SHA-256 content-based duplicate detection
- Indexed per-camera frame catalog in SQLite
- Chunk-bounded folder hashing/staging with atomic destination commits
- Transactional frame-catalog writes with checkpoints during long batches
- Phase-aware scanning, hashing/staging, commit, duplicate, error, and persistence progress
- Camera creation and index rebuilding
- Source frames stored once in the camera’s `unsorted/` directory

### ROI management

- Draw normalized rectangular ROIs on an ingested frame
- Pin a preferred frame as the ROI-editor background
- Edit existing rectangles by dragging or resizing
- Define quality ROIs
- Define a product-classification ROI and its product classes
- Define product-specific ROIs
- Share a camera-level quality ROI across selected products
- Delete an ROI with confirmation and purge its associated state
- The frame picker leaves out soft-deleted frames (`GET /cameras/{camera}/frames` drops them from `frames` and `total`; v1.28.0)

### Classification

- Metadata labels; source frames do not move
- Default binary quality classes: `OK` and `NG`
- Multi-class product classification
- Per-frame labeling, by buttons or by keyboard: hover a card and press 1-9 (class in listed order; the same number again removes the label), 0 (clear label) or the key left of 1 (toggle golden)
- Bulk labeling of filtered selections
- Bulk clearing of labels in the current Show filter (all pages); goldens are kept unless explicitly included, and clearing a golden's label removes its golden mark
- Per-class golden reference marks
- Goldens and labels kept consistent transactionally in the domain API
- Pagination and configurable grid columns
- Bulk state snapshots for full grid renders and targeted per-frame reads for fragment updates
- Render-scoped frame, ROI, and product-membership snapshots with explicit mutation invalidation
- Bulk Status label, golden, and version summaries
- Filtering by label state and method disagreement
- Ranking by novelty, confidence margin, and available scoring methods
- Persistent scored-result caching using plain JSON; compression was measured and rejected as latency-neutral at current scale
- Bounded bulk cache discovery and feature-cache writes
- Bounded decoded-vector batches during candidate scoring
- Concurrent exact classical comparisons and matrix-vectorized neural comparisons
- Phase-aware refresh status covering discovery, feature preparation, comparison, persistence, and grid presentation
- Bounded encoded thumbnail caches with ROI/file-change invalidation and hit/miss diagnostics
- Visible grid-card preparation plus 24-card page-size guidance for responsive labeling
- Painting (v1.29.0, `classify/paint.ts`, used by every `Card`): hold a class key 1-9 and move the mouse over cards; each unlabeled card entered gets that label. Labeled cards keep theirs (change them with a single press) and goldens never change. Holding 0 clears labeled non-golden cards instead. Golden has no paint mode. The cursor becomes a dot in the class colour (OK green, NG red; grey cross for 0). Only real pointer movement paints (a scroll under a still pointer does not), each card acts once per stroke, and a stroke ends on key release or window blur. No stroke-level undo

### Vision settings: filter, mask, detector

Per (camera, feature), edited on the Detector page; see the README section for the user view.

- Pre-processing filters (OpenCV) applied to each ROI crop before features and embeddings, with live preview
- Object mask (rectangle, circle, polygon; dark grey outside) applied after the filter when enabled
- Exemplar-based object detector (OWL-ViT, optional dependency) that finds the object per frame; the mask is translated onto each frame's trusted detection
- Stored detections with human review: accept, adjust, clear; human boxes survive re-detection
- Everything is metadata: vectors, results, scatter and cluster caches are derived and recomputed when settings or boxes change
- Frozen versions record the settings and trusted boxes (Versions page "vision" column)

### Scoring

The application presents independent scoring opinions:

- `cpu`: HSV histogram, MSE, and SSIM combined as one classical family
- `resnet18`: cosine distance between pretrained embeddings
- `resnet50`: cosine distance between pretrained embeddings

For each method, the application can show:

- Distance to the nearest golden of each represented class
- Nearest-class leaning
- Confidence margin between the two closest classes
- Novelty relative to all represented goldens

Neural methods are optional. The classical method remains available without PyTorch.
Neural inference uses conservative configurable batches with automatic smaller-batch
retry on runtime capacity failures. Classify and near-duplicate analysis share the
same feature-cache pipeline.

Classical SSIM retains its original formula and is evaluated concurrently across
independent candidate/reference pairs. The refresh keeps decoded golden vectors
and one bounded candidate group in memory rather than decoding the complete frame
set at once.

### Pipeline stages

- Each ROI's progress through the pipeline, derived from stored state only (no new state): dedup (optional; listed right after Ingest since v1.28.0, but it still embeds an ROI crop, so it needs an ROI), ROI, filter & detector (optional), labels, goldens, scores, edge angle (optional), augmentation (optional), version, export. Statuses: done, partial, stale (scores older than the goldens), todo; `next` is the first required stage not done
- Overview ROI cards show a labeled-frames progress bar and the stage chips; a chip opens the page that does the stage on that ROI and product (`App.openStage`). A step bar (`StepBar.tsx`) shows the same strip above the pages that work on one ROI and reloads on page, ROI or camera change
- The ROI being worked on is shared between the pages through `SharedFeature.tsx` (a context with a harmless default, so a page still works on its own); the pages with an ROI selector pick the shared ROI when they offer it and publish their choice
- `pipeline.py`, `GET /api/overview` (`pipeline` per ROI), `GET /api/cameras/{camera}/pipeline?feature=`, `PipelineChips.tsx`, `StepBar.tsx`. Overview: about 4.5 ms per ROI (80 ROIs: about 0.36 s)

### Augmentation ranges

- Augmentation page: per frame, the object's shift (px of the ROI crop) and optionally rotation (degrees) against a reference frame; suggested ranges from the central N% of the distribution, editable and saved per ROI
- Shift from a trusted stored detection box when there is one, else phase correlation refined by an ECC alignment (a rotated frame biases phase correlation); rotation from the ECC alignment; frames with no clear match are counted as not measured
- Measures and records only: it never creates or changes an image (training-time augmentation stays out of scope). Ranges are frozen in the version statistics (`stats.augmentation`) and listed on the Versions page; exports stay without a manifest
- Settings, ranges and per-frame results are metadata in `settings` (no schema change); results are signed and recomputed when the reference frame, source, rotation option, filter or detector change; changing ranges, coverage or the class filter needs no new run
- `motion.py`, `api/motion_api.py`, `views/AugmentationView.tsx`, `classify/Histogram.tsx`. Checked on synthetic images with known shifts and rotations only; not yet calibrated on real camera frames

### Edge-angle rule

- Edge angle page: draw a line along an edge, size a band, see the straightened band with the points found and the fitted line; measure the angle (0-180°) and direction (brighter side) per frame
- A separate, rule-based opinion (no PyTorch); pass/fail against an expected angle ± tolerance and polarity, taken from an OK example; frames with no usable edge are undetermined
- Settings and per-frame results are metadata in `settings` (no schema change); results are recomputed when the line, band, points or filter change; the verdict follows the current expectation without a new run
- Classify shows a badge per measured card and the Show filters `Edge angle: pass / fail / undetermined`; a freeze records the rule in the version statistics
- The crop is shown in a shared zoom/pan viewport (`ZoomPane.tsx`, pure maths in `zoomGeometry.ts`; v1.23.0): wheel zoom at the cursor (0.5x-16x), middle-button / Space+drag / background pan, Reset, 1:1, keyboard `+ - 0`, pixel and line readout, picture-size slider, view kept across frames. The layer is resized, not scaled, so handles keep their size and normalised coordinates keep working; the view is stored as zoom plus the picture point at the box centre. Edge angle (`LineCanvas`) and every `RoiCanvas` (ROI editor and Detector) use it; in draw mode a left drag draws, so panning there is middle button or Space+drag (Space/middle are taken in the capture phase, ahead of the layer's own handlers), in edit mode dragging the background pans too. The ROI editor view is kept across frames and reset on camera/product change (v1.28.0)
- `edge_angle.py`, `api/rules_api.py`, `classify_api._edge_state`, `views/EdgeAngleView.tsx`, `LineCanvas.tsx`, `lineGeometry.ts`. Checked on synthetic images with known angles only; not yet calibrated on real camera frames

### Find similar

- Classify card action (🔍≈, ResNet methods only): unlabeled, live, unmuted frames of the feature ranked by cosine distance to a labeled seed frame, over the shared embedding cache (filter and mask apply)
- A distance slider ticks everything within a distance; ticks can be edited per picture; only the seed's label is applied, in one bulk write tagged `source="similar"`; goldens are never created
- The server re-checks each frame when applying and skips any that was deleted, labeled, or is not part of the feature since the list was made
- `neighbors.py`, `api/similar_api.py` (`POST classify/similar` job, `POST classify/label-frames`), `classify/SimilarPanel.tsx`; no stored state. Distinct from Bulk label and Auto-assign, which are golden-based

### Outlier scoring

- Scatter selection grid (v1.38.0): the frames inside the scatter rectangle are shown in the shared paged card grid (same Pager, columns, per-page setting, cards and picture viewer as everywhere else), under a button row between the map and the grid: class-coloured "Label N as X" buttons in one group, and a red-outlined "Delete these N frame(s)…" apart. Labels, goldens and deletes done from the selection (batch or per card) show on the map at once without projecting again. Panel groups are ordered Clusters, Scatter, Outliers.
- Scatter as a function (v1.37.0, Dedup): the 2D scatter is its own group in the right panel (projection UMAP/t-SNE, Colour by cluster / label / outlier score / nothing, Compute projection) and a third active function: when active, the map fills the centre width, with a legend and the same drag-to-select panel (label or delete the selection). `POST /dedup/scatter` no longer needs a Cluster run: it takes `method` (the embedding), projects the live frames' embeddings (the held clustering's when it is for the same embedding), and returns each point's `label`, `golden`, and `cluster`/`representative` only when a clustering for that embedding is held (`cluster` is null otherwise). Colouring by cluster or outlier score falls back to labels with a note when that data does not exist. A new clustering refreshes an existing map; a different embedding clears it.
- Cluster tabs (v1.36.0): the cluster list beside the picture grid is now a row of tabs above it, "0 (12)", "1 (5)", ... and "Unique (3)" last (cluster number and frame count only; the row wraps when there are many), and the grid below shows the chosen one.
- Step bar counts stay current (v1.35.3): every successful non-GET request fires a `picturesorter:changed` window event (`api.DATA_CHANGED`), and the step bar reloads its pipeline 300 ms after the last one, so "N of M frames labeled" follows labeling, painting, deleting and so on without a page change.
- Dedup status card (v1.35.2): the number of frames in scope is a card at the top of the right-hand column, above the options panel (the explanatory DBSCAN text and the neural-device note were removed from the page; the device is shown in the sidebar badge).
- Active function (v1.35.0, Dedup): the right panel groups (Clusters, Outliers, more to come) are functions, and only one is active at a time; it has a tinted background and an "● active" tag, and its results fill the centre of the page. Opening or closing a group by its header changes nothing else. Pressing a group's own button (Cluster, Score outliers) makes it the active one: the previous active group deactivates and collapses, the new one opens, and the centre switches. The Clusters group holds Epsilon, Min points, Cluster, Revert, then Apply mute with a status line "N frame(s) will be muted" at its bottom (Apply mute is disabled while Clusters is not the active function, so it never acts on hidden clusters). The deactivated function's results are kept, not shown; pressing its button shows them at once while the new run recomputes. Outlier scores are still discarded when the ROI or the embedding changes. (This may change later to allow several active functions.)
- Sidebar foot (v1.34.0): bottom left shows a hardware badge (`HardwareBadge`, from `GET /api/device` = `embedding.device_info()`: kind amd/nvidia/cpu, label, card/CPU name, compute API, and a hint when a GPU exists but the CPU build is installed), under it the app version and date, and an icon-only Configuration link at the bottom right (clicking it again on Configuration returns to the page you came from). The badge has three looks (card picture, chip row, banner); clicking it cycles them and the choice is kept in the browser. The pictures are drawn SVGs, no downloaded logos. Dedup's Epsilon, Min points, Cluster and Revert sliders are in a Clusters group of the right panel, and those sliders answer the mouse wheel.
- Picture viewer (v1.33.0, Dedup cluster cards and Outlier cards): clicking a card's picture opens the full frame in an overlay (`classify/FrameViewer.tsx`) instead of a new tab (Ctrl/middle click still opens a tab). It walks the cards in grid order across all pages (← →, the grid turns to the page of the shown frame), zooms with the wheel, pans by dragging, has Reset and 1:1 (shared `ZoomPane`), and acts on the shown frame with the card keys: 1-9 label, 0 clear, the key left of 1 golden, Delete delete. Escape, the close button or a click outside closes it. The file name sits under the picture (wrapped, selectable) and the toolbar is grouped: browse, label and golden, then delete and close apart. Its keys are taken before the page's, so cards under the overlay never react.
- Mouse-wheel sliders (v1.32.1, trial on the Outliers k slider only): `WheelRange` moves a range input one step per wheel notch while the pointer is over it (up = more) and keeps the page from scrolling; the other sliders get it once the behaviour is judged.
- Right options panel (v1.31.0, trial on Dedup only): a collapsible panel on the right of the page (`SidePanel`) holds the Embedding and Feature (ROI) dropdowns (Embedding above ROI) and a collapsible "Outliers" group (k slider, Score outliers, progress; `PanelGroup`), while the outlier result cards stay in the page body; collapsed state is remembered in the browser for every page. Other pages still have the dropdown inline; the plan is to move more controls there once the layout is judged.
- Dedup page panel: each live frame's mean cosine distance to its k nearest other frames (k 1-20, default 5) over the Dedup embeddings, so the feature's filter and mask apply
- Most isolated frames listed first as cards (label, golden, delete); the 2D projection can be coloured by the score
- Derived on demand (`outliers.py`, `api/outliers_api.py`, `classify/OutlierPanel.tsx`); no stored state. A review aid, not a verdict; independent of the clustering parameters

### Verdicts (v1.26.0)

- One OK / NG verdict per picture (`verdicts.py`, `api/verdicts_api.py`, `views/VerdictView.tsx`, `VerdictBar.tsx`): inputs are the OK / NG labels of the quality ROIs; all equal = automatic verdict, any mix = contradiction, none = open. Derived on read; only the user's decisions are stored (`verdict_decisions`, schema v8) with a signature of the inputs, so a later label change makes the decision stale
- Labels record where they were set (`labels.via`: Classify, Classify bulk, Classify auto-assign, Dedup, Find similar, ...; older labels show "page unknown")
- Endpoints: `GET /api/cameras/{camera}/verdicts/summary`, `GET /api/cameras/{camera}/verdicts?status=&page=&per_page=`, `PUT /api/cameras/{camera}/verdicts/decision`; `/api/overview` carries the summary per camera
- Overview shows the bar (OK, NG, contradictions, stale, open, duplicates = open and muted by Dedup) and the deleted count
- Export and project versions from verdicts: see Versions below (v1.27.0). The old golden-only export of ROI versions was removed; the pipeline stage "Export" now means the latest project version was exported
- The Verdict page shows its cards like Classify (v1.29.2): the shared pager (first/prev/next/last, per page, columns) and a column grid instead of a picture-size slider, plus hover keys (1 = OK, 2 = NG, 0 = clear my decision). Verdict has no ROI, so per-page and columns are stored camera-wide (`verdict.grid.perpage` / `verdict.grid.cols`, `PUT /verdicts/grid-settings`, returned as `settings` by the listing) rather than in Classify's per-ROI setting

### Insights

- Method-level comparison of current scored results
- Confusion-style summaries against existing human labels
- Visibility into agreement and disagreement between methods
- Every non-zero matrix cell is clickable (rows = your label, columns = the method's leaning), so false positives and false negatives can be reviewed: `GET /cameras/{camera}/insights/cell` returns the held-out frames behind the cell (same rule as the count; goldens excluded) as Classify card data. They are shown as the same cards with the same hover keys, and the same paged grid and per-page / column setting as Classify. Labeling, golden or deleting a card refreshes the counts; the open list keeps its cards until closed

These views evaluate the curation aid; they do not establish classifier accuracy.

### Versions

- Freeze labels and goldens as a numbered snapshot
- Store frame hashes, counts, notes, and available score statistics
- Keep one active version per camera and feature
- Compare version counts with the preceding version
- Replace working metadata from an earlier snapshot without deleting saved versions
- Project versions (v1.27.0): freeze the verdicts (`versions.freeze_project`, reserved feature `@project`, items of kind `verdict`), export OK / NG pictures into `exports/project/v<NNN>__<name>/<class>/` (`versions.export`, `GET/POST /api/cameras/{camera}/project-versions`, `POST .../{id}/export`), `ProjectVersions.tsx`. Pictures without a valid verdict are not in a version; no revert
- Verify hashes during export
- Report missing or changed source frames
- Record values measured downstream (metric name, number, day, note) against a version; compare them across versions; edit and delete entries (`version_results`, schema v7). The app only stores them: they never affect scoring, and the metrics themselves are defined by the downstream system

## Active architecture

The application is a FastAPI backend (`app/backend/`) that wraps the domain modules and serves a React + TypeScript single-page app (`app/frontend/`). The backend binds `127.0.0.1` and has no authentication: it is a local single-user tool.

### Entry point and configuration

- `app/backend/api/main.py` — FastAPI app factory; serves the built frontend (`app/frontend/dist`) with SPA fallback
- `app/backend/config.py` — paths, classes, metric families, and optional embeddings
- `app/backend/api/jobs.py` — in-memory background jobs (one worker) for ingest, scoring, clustering, projection; polled via `GET /api/jobs/{id}`

### Domain and persistence

- `app/backend/roi.py` — ROI representation and normalized cropping
- `app/backend/datamodel.py` — camera, product, feature, and frame scoping
- `app/backend/ingest.py` — import and exact duplicate detection
- `app/backend/db.py` — SQLite schema and low-level persistence
- `app/backend/labels.py` — direct label/golden state and transactional invariants
- `app/backend/versions.py` — freeze, revert, and export behavior

### Scoring

- `app/backend/curation.py` — classical feature extraction and distances
- `app/backend/embedding.py` — optional pretrained ResNet embeddings
- `app/backend/classify.py` — multi-class scoring and the shared persistent feature cache
- `app/backend/dedup.py` — near-duplicate embedding clustering using the shared cache
- `app/backend/outliers.py` — k-nearest-neighbour isolation score over the same embeddings
- `app/backend/pipeline.py` — the pipeline stage of each ROI, derived from stored state
- `app/backend/motion.py` — object shift/rotation measurement against a reference frame and the suggested augmentation ranges
- `app/backend/methods_config.py` — which scoring methods are active (global setting `methods.active` in `settings`, pseudo-camera `_global`); `classify.methods_available()` follows it; `api/config_api.py` serves `GET/PUT /api/config/methods` (v1.24.0)
- `app/backend/edge_angle.py` — edge-angle measurement, verdict, settings and per-feature results (rule-based family)
- `app/backend/neighbors.py` — nearest unlabeled frames to a labeled seed, and the guarded batch-apply of the seed's label
- `app/backend/classify_view.py` — presentation-neutral filtering, sorting, bars, bulk and auto-assign selection
- `app/backend/suggest_goldens.py` — most-uncertain, diversity-spread golden suggestions
- `app/backend/insights.py` — per-method confusion matrices
- `app/backend/thumbs.py` — bounded-cache ROI cutout and square thumbnails
- `app/backend/preprocess.py`, `masking.py`, `vision_settings.py` — per-feature OpenCV pre-processing filters and rectangle/circle/polygon object masks (dark-grey outside) applied to ROI crops before features/embeddings (Detector page)
- `app/backend/detector.py`, `detections.py` — exemplar-based OWL-ViT object detector (optional `requirements-detector.txt`; backend pluggable), stored boxes with human review, and the per-frame mask offsets derived from them. Remaining work in `plans/detector-masking-plan.md` (Phase 4)

### API (`app/backend/api/`)

One thin router per area, each delegating to the domain modules above:
`cameras`, `status`, `versions_api`, `ingest_api`, `frames_api` (frames and thumbnails),
`roi_api`, `classify_api`, `insights_api`, `dedup_api`, `overview_api` (all cameras with reference frame and ROIs for the Overview page), `outliers_api`, `similar_api`, `config_api` (active scoring methods), `rules_api`, `motion_api`, `vision_api` (filter catalogue, per-feature filter/mask/detector settings, live preview, detection job and review).

### Frontend (`app/frontend/src/`)

- `App.tsx` — sidebar (camera, product, view) and routes
- `api.ts` — typed API client
- `views/` — Overview, Status, Ingest, Dedup, ROI editor, Detector, Edge angle, Classify, Insights, Augmentation, Versions (sidebar order)
- `classify/` — card, bulk, clear-labels, auto-assign, suggested-goldens panels, SVG scatter (drag a rectangle to zoom and list the frames inside, optionally delete them with a note, or label them all as one of the feature's classes with the "Label N as <class>" buttons, which overwrite existing labels and keep goldens in step; right-click resets), per-day Deleted view (follows the Classify per-page / column setting and pages through the days, newest first; v1.29.1), cluster browser (vertical cluster list, paged card grid per cluster with its own grid size per ROI; cards can be labeled, made golden, made representative or deleted, with the same hover keys as Classify, plus Delete)
- `RoiCanvas.tsx` + `roiGeometry.ts` — pointer-driven ROI draw/move/resize in normalised coordinates
- `views/ConfigurationView.tsx` (method checkboxes), `methodTags.ts` (CPU/R18/R50), `views.ts` (menu icons, `CONFIG_VIEW` pinned at the bottom of the sidebar)
- `ZoomPane.tsx` + `zoomGeometry.ts` — zoomable, pannable bordered picture viewport (used by `LineCanvas`; planned for the other canvases)
- `DetectorPanel.tsx` — frame strip, run bar and review panel of the tabbed Detector page (`views/DetectorView.tsx`: Filter / Detector / Review / Mask tabs, sticky save bar, shared preview); `CopyButton.tsx` — copy-to-clipboard button (Versions export path)
- `ShapeCanvas.tsx` + `shapeGeometry.ts` — editable mask shape (rectangle, circle, polygon) with drag handles
- `useJob.ts` — polls background jobs

## Storage model

```text
cameras/
  <camera>/
    unsorted/     immutable source frames
    exports/      generated version exports

data/
  picture_sorter.db
```

SQLite contains the frame/hash catalog, ROI definitions, direct current labels,
goldens, deletion and dedup-mute sets, explicit versions, settings, feature
caches, and scored-result caches. There are no event-history projections or
compatibility triggers. Images are the only camera-local file artifacts; every
piece of curation state is in the database.

## Current real-world findings

Tests on representative camera data show that many batches contain extremely similar frames.

Observed consequences include:

- ResNet embedding distances can occupy a very narrow range.
- OK/NG margins can be extremely small.
- Equal classical metric weights do not imply equal practical influence.
- SSIM currently dominates the classical family on tested data.
- MSE has contributed little to the observed ranking.
- Classical and ResNet methods provide meaningfully different opinions.

Therefore:

- Leaning is a review aid, not a calibrated prediction.
- Margin is a relative uncertainty signal, not a probability.
- Method disagreement is valuable review information.
- Bulk labeling requires human-selected thresholds and careful review.

See [[findings-real-data-method-comparison]] for the recorded measurements.

## Known limitations

### Detector

- The OWL-ViT path has been run on real frames once (275 frames, none below a 50% threshold) but its confidence scores are not calibrated or validated; a high score does not prove the box is right. Check boxes with "Show all frames".
- The mask follows the detected object by translation only; rotation and scale changes are not followed.
- Detection uses the saved settings, not unsaved edits.

### Metric calibration

The classical metrics are nominally combined with equal weights, but their effective scales differ. The current CPU-family score is not calibrated across ROIs or datasets.

### Near-duplicate selection

Ranking by distance from goldens does not ensure diversity among the candidates selected in the same batch. Several highly ranked candidates can still be near duplicates of one another.

### Alignment and lighting

Pixel-based metrics remain sensitive to small spatial shifts and lighting changes. The current scoring pipeline does not perform explicit alignment or lighting normalization.

### Confidence interpretation

Margins are not calibrated probabilities and should not be compared blindly between unrelated ROIs or scoring methods.

### Product-aware summaries

The main hierarchy is implemented, but Status and Versions presentation still need clearer per-product grouping.

### Runtime portability

The project folder is portable, but `.venv/` is machine-specific and must be recreated after moving the project. The camera folders and SQLite database are the valuable data that must be backed up.

- Scatter projection speed: see [docs/scatter-performance.md](scatter-performance.md) (measurements, what helped and what did not).

## Open work

Listed in recommended priority order:

0. **Try the 2026-10-15 tools on real data** (nothing in v1.15.0-v1.20.0 has been used on the real cameras or in a browser): Overview stage chips and the step bar, Outliers, Find similar, the edge-angle rule (angle, band width), augmentation ranges (the "not measured" counts), the downstream results form. See `memory/handover-new-tools.md`.
1. Find out which quality metrics the downstream system reports, then refine the Downstream results form (today: free-text metric names).
2. Add focused automated tests for product-scope, version, and export invariants.
3. Measure and normalize classical metric scales per representative ROI.
4. Add coverage-aware or farthest-point selection to reduce candidate redundancy.
5. Consider aligned difference views or heatmaps for faster human verification.
6. Improve per-product grouping in Status and Versions.
7. Add browser-level (end-to-end) tests for the React views; current frontend tests mock the API and cannot exercise real pointer interaction.
8. Build the `setup_torch.sh` / `setup_torch.ps1` hardware detect-or-ask helper; investigate the flaky `test_clean_schema.py::MigrationV3ToV4Tests::test_parallel_first_connects_all_succeed`. See `memory/gpu-backends-rocm.md`.

Deferred (discussed, not planned): embedding drift over time (filenames carry `dd.mm.yyyy_hh.mm.ss`), reorganizing the menu into tabs or branches, further rule-based tools (object counting, presence in a zone, colour threshold, blob area).

## Explicitly out of scope

Unless the project direction changes, the following remain outside this tool:

- Training the final production classifier
- Performing training-time image augmentation
- Automatically replacing human labels with model predictions
- Moving source frames as part of classification
- Blending classical and ResNet scores into one hidden verdict

## Running safely

Create a machine-local Python environment from the dependency files and run:

```powershell
./run.sh
```

Tests and verification must use temporary locations through:

```text
CURATION_CAMERAS_ROOT
CURATION_DATA_DIR
```

They must not mutate the real camera folders or `data/picture_sorter.db`.

## Documentation authority

For current work, read:

1. `CLAUDE.md` — concise working instructions and critical invariants
2. `docs/current-project.md` — current state and architecture
3. `docs/data-model.md` — canonical domain model
4. `docs/methodology.md` — stable scoring concepts

Historical rationale may be consulted from `memory/` and `plans/` when needed.

## Related documents

- [[data-model|Canonical data model]]
- [[methodology|Scoring methodology]]
- [[findings-real-data-method-comparison|Real-data scoring findings]]
- [[flow-and-roadmap|Historical flow and roadmap]]
- [[multi-product-hierarchy|Multi-product hierarchy design]]
- [[classify-and-versioning|Classification and versioning design]]
- [[todo-roi-image-fullwidth|ROI editor sizing issue]]

## Platform status

- GPU backends: ResNet and the detector run on whatever PyTorch build is installed per machine: CPU, Nvidia CUDA, or AMD ROCm (Linux only). Device selection is automatic (`embedding.active_device()`); `embedding.device_label()` names the vendor in the UI. Windows + AMD uses the CPU build. ROCm is verified on the Linux dev machine (RX 7800 XT, `gfx1101`, torch 2.14.1+rocm7.2, no `HSA_OVERRIDE_GFX_VERSION` needed) in a separate `.venv-rocm` (git-ignored; `run.sh` prefers it when present, `PICTURE_SORTER_VENV=.venv` forces the CPU one): all backend tests pass; on 256 synthetic 320x240 frames resnet18 ran at about 678 frames/s vs 163 on CPU, resnet50 about 405 vs 59, with identical embeddings (cosine 1.0); OWL-ViT detection took about 95 ms/frame vs 367 ms on CPU with the same box. Windows + Nvidia and Windows + AMD (CPU) remain untested here. An install/detect helper script (`setup_torch.sh`/`.ps1`) is planned, not built.

- Linux: verified (development platform).
- Windows: expected to work but **untested** since the move to FastAPI + React; `run.sh` is bash-only; Windows uses `run.ps1` or the manual commands in the README section "Running on Windows". `run.ps1` mirrors `run.sh` but has never been run (written without a Windows machine).
