---
name: current-project
description: Authoritative snapshot of the current purpose, architecture, capabilities, limitations, and open work
status: current
document_type: project-status
last_updated: 2026-08-03
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

### Ingest

- Multi-file upload through Streamlit
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

### Classification

- Metadata labels; source frames do not move
- Default binary quality classes: `OK` and `NG`
- Multi-class product classification
- Per-frame labeling
- Bulk labeling of filtered selections
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

### Insights

- Method-level comparison of current scored results
- Confusion-style summaries against existing human labels
- Visibility into agreement and disagreement between methods

These views evaluate the curation aid; they do not establish classifier accuracy.

### Versions

- Freeze labels and goldens as a numbered snapshot
- Store frame hashes, counts, notes, and available score statistics
- Keep one active version per camera and feature
- Compare version counts with the preceding version
- Replace working metadata from an earlier snapshot without deleting saved versions
- Export a frozen version into class folders
- Verify hashes during export
- Report missing or changed source frames

## Active architecture

### Entry point and configuration

- `scripts/app.py` — Streamlit entry point and view dispatch
- `scripts/config.py` — paths, classes, metric families, and optional embeddings
- `scripts/ui_common.py` — shared Streamlit presentation helpers

### Domain and persistence

- `scripts/roi.py` — ROI representation and normalized cropping
- `scripts/datamodel.py` — camera, product, feature, and frame scoping
- `scripts/ingest.py` — import and exact duplicate detection
- `scripts/db.py` — SQLite schema and low-level persistence
- `scripts/labels.py` — direct label/golden state and transactional invariants
- `scripts/versions.py` — freeze, revert, and export behavior

### Scoring

- `scripts/curation.py` — classical feature extraction and distances
- `scripts/embedding.py` — optional pretrained ResNet embeddings
- `scripts/classify.py` — multi-class scoring and the shared persistent feature cache
- `scripts/dedup.py` — near-duplicate embedding clustering using the shared cache

### Views

- `scripts/view_status.py`
- `scripts/view_ingest.py`
- `scripts/view_roi_editor/`
- `scripts/view_dedup/`
- `scripts/view_classify/`
- `scripts/view_insights.py`
- `scripts/view_versions.py`

## Storage model

```text
cameras/
  <camera>/
    unsorted/     immutable source frames
    rois.json     ROI definitions
    exports/      generated version exports

data/
  picture_sorter.db
```

SQLite contains the frame/hash catalog, direct current labels, goldens, deletion
and dedup-mute sets, explicit versions, settings, feature caches, and scored-result
caches. There are no event-history projections or compatibility triggers. Images
are stored only as files and ROI definitions remain in `rois.json`.

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

### ROI editor sizing

The ROI canvas does not reliably occupy the intended browser width on every display.

### Runtime portability

The project folder is portable, but `.venv/` is machine-specific and must be recreated after moving the project. The camera folders and SQLite database are the valuable data that must be backed up.

## Open work

Listed in recommended priority order:

1. Add focused automated tests for product-scope, version, and export invariants.
2. Measure and normalize classical metric scales per representative ROI.
3. Add coverage-aware or farthest-point selection to reduce candidate redundancy.
4. Consider aligned difference views or heatmaps for faster human verification.
5. Improve per-product grouping in Status and Versions.
6. Resolve the ROI-editor width behavior.

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
streamlit run scripts\app.py
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
