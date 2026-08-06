# Picture Sorter for NN Training

A local Streamlit tool for preparing compact, reliable image datasets for camera-based vision classification.

You ingest camera frames, define regions of interest, label products and quality classes, mark trusted labeled frames as references, compare machine-generated scoring opinions, and export frozen dataset versions.

The human makes every classification decision. Source frames remain unchanged; labels and references are stored as metadata.

## Current workflow

```text
Ingest
  → define ROIs
  → classify product when needed
  → classify quality by product and ROI
  → mark trusted labeled frames as goldens
  → refresh scores and review uncertain frames
  → freeze a version
  → export training folders
```

For the current architecture, capabilities, limitations, and open work, see [Current project](docs/current-project.md).

For canonical entities and domain rules, see [Data model](docs/data-model.md).

## Requirements

- Windows with PowerShell, or Linux/macOS with a POSIX shell
- A supported Python installation (verified on Python 3.12)
- Approximately 32 GB RAM is comfortable for the existing datasets
- No GPU is required for classical scoring
- PyTorch is optional for ResNet scoring

## Setup

Run from the project root.

**Windows (PowerShell):**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

**Linux / macOS:**

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

The virtual environment is machine-specific. If the project was copied from another computer, delete or ignore the copied `.venv/` and create a new one. `.venv/` is git-ignored, so it never arrives with a clone and must always be created locally.

Do not install the requirements into the system Python. Without the virtual
environment the application appears to start — Streamlit serves a page — and
then fails inside it on the first missing import, typically `cv2` or `skimage`.

## Run

From the project root, **not** from `scripts/`.

**Windows (PowerShell):**

```powershell
.\.venv\Scripts\Activate.ps1
streamlit run scripts\app.py
```

**Linux / macOS:**

```bash
source .venv/bin/activate
streamlit run scripts/app.py
```

Or without activating, using the environment's own launcher:

```bash
.venv/bin/streamlit run scripts/app.py
```

`run.sh` wraps that last form and works from any working directory. It checks
the environment first and reports what to install if anything is missing, rather
than failing later in the browser. Extra arguments are passed to Streamlit:

```bash
./run.sh
./run.sh --server.address 127.0.0.1
```

If port 8501 is already in use, Streamlit selects the next free port and prints
the chosen URL. An explicitly requested port is not moved: `--server.port 8502`
fails outright when 8502 is taken. Use `--server.address 127.0.0.1` to keep the
app off other machines on the network; by default it binds every interface.

The application provides six views:

- **Status** — label, golden, version, and ROI-definition summaries
- **Ingest** — add frames and maintain the duplicate index
- **ROI editor** — create, edit, scope, or delete ROIs
- **Classify** — label frames and compare scoring opinions
- **Insights** — compare method behavior against human labels
- **Versions** — freeze, revert, and export dataset snapshots

The sidebar selects the camera. When a camera has a product-classification ROI, it also selects either the product-sorting stage or one product’s quality stage.

## Add images

Use the **Ingest** view.

Images can be added through:

- Multi-file upload
- A local folder path

Folder imports are non-recursive.

Every frame is stored under:

```text
cameras/<camera>/unsorted/
```

Despite the directory name, `unsorted/` is the permanent immutable frame store. Classification does not move files out of it.

Duplicates are detected by SHA-256 file content, not filename. Folder contents
are hashed and staged incrementally, so import memory does not grow with the sum
of all file bytes. The live status identifies scanning, hash/stage, commit, and
index-persistence work, including duplicate and error counts. If files were added
or changed outside the application, use **Maintenance → Rebuild duplicate index**.

The Maintenance section can also create a new camera.

## Define ROIs

Use the **ROI editor** to select an ingested frame and draw a rectangle.

ROI coordinates are normalized, so the same rectangle applies when source-image dimensions vary.

A named ROI is a feature. It may be:

- A camera-level quality ROI
- A product-classification ROI
- A product-specific quality ROI
- A shared quality ROI used by several products

A product-classification ROI has `role="classify"` and defines the camera’s
product classes.

Deleting an ROI requires confirmation and removes its associated labels,
goldens, cached results, versions, and deduplication state. Source frames remain unchanged.

## Classify frames

Use the **Classify** view.

### Label and mark references

Each frame can receive one current label for the selected feature.

A golden is a trusted labeled frame used as a class reference:

- A frame must be labeled before it can be golden.
- Its golden class follows its label.
- Relabeling a golden moves the reference to the new class.
- Goldens are metadata marks; there is no separate golden-image folder.

### Refresh scores

After adding or changing goldens, refresh the scores.

Each non-golden frame is compared with the nearest golden of every represented class. The interface can show:

- **Leaning** — the nearest represented class
- **Margin** — separation between the two nearest classes
- **Novelty** — distance from the nearest reference of any class
- **Method disagreement** — scoring methods prefer different classes

These values assist review. They are not calibrated probabilities and do not replace human judgment.

Expensive image features are cached, so later refreshes usually recompute distances rather than extracting every feature again.

### Review and label

Frames can be labeled individually or through an explicitly selected bulk operation.

Useful review strategies include:

- Smallest margin first
- Highest novelty first
- Methods-disagree filter
- Unlabeled-only filter

Pagination and grid-column controls make larger batches manageable. The default
24-card page is recommended for the most responsive labeling flow; 48 and 96
remain available when reducing pagination is more important. Thumbnail caches
are bounded and keyed by both ROI geometry and source-file modification time.

## Scoring methods

The application keeps scoring methods independent.

### Classical CPU method

Always available through the base dependencies:

- HSV histogram distance
- Mean squared error
- Structural dissimilarity (`1 − SSIM`)

These values are combined into the `cpu` method.

The current metrics do not have equal effective scales on all datasets. In observed data, SSIM has often dominated the classical result. Treat the ranking as a review aid.

See [Methodology](docs/methodology.md) for the scoring concepts.

### Optional ResNet methods

Optional pretrained ResNet18 and ResNet50 embeddings provide separate neural opinions. They do not train a model and are not blended with the classical score.

Install the optional dependencies with:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r requirements-embedding.txt
```

For a guaranteed CPU-only PyTorch installation:

```powershell
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
```

On Linux/macOS the same two installs are:

```bash
.venv/bin/pip install -r requirements-embedding.txt
.venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
```

Choose the CPU-only build on any machine without an Nvidia GPU, including AMD
cards. The default PyPI wheels carry CUDA libraries that add roughly 2 GB and
cannot be used there. CPU inference is fast enough for this tool: on a 16-thread
desktop CPU, resnet18 reaches about 157 frames/s and resnet50 about 66
frames/s, so the classical method and the batch sizes in `config.py` remain the
practical limits rather than the model.

Installing `umap-learn` may downgrade `numpy` slightly, because `numba` pins a
supported range. This is expected; run `pip check` afterwards to confirm the
environment is still consistent.

The application automatically uses CUDA when a compatible PyTorch build and Nvidia GPU are available; otherwise it uses the CPU.

The first neural run downloads pretrained weights — about 45 MB for resnet18
and 98 MB for resnet50 — into the PyTorch cache, once per machine.

## Freeze and export versions

Use the **Versions** view after reviewing the working labels and goldens.

### Freeze

Freezing creates a numbered metadata snapshot containing:

- Labels
- Golden marks
- Frame hashes
- Counts
- Available score statistics
- Name and notes

A version is a small reproducible recipe, not a copy of the source images.

### Revert

Reverting replaces the working labels and goldens from a selected snapshot.
Other saved versions remain available.

### Export

Export materializes a frozen version into class folders under:

```text
cameras/<camera>/exports/<feature>/<version>/<class>/
```

The exported files are ROI cutouts suitable for downstream training.

Before writing each cutout, the exporter verifies the source-frame content hash. Missing or changed frames are reported.

## Project storage

```text
cameras/
  <camera>/
    unsorted/       immutable source frames
    rois.json       ROI definitions
    exports/        generated training-folder exports

data/
  picture_sorter.db

docs/
  current-project.md
  data-model.md
  methodology.md

scripts/
  app.py
  view_*/
  domain and persistence modules

memory/             historical project notes and findings
plans/              historical implementation plans
```

The important data is:

- `cameras/`
- `data/picture_sorter.db`

Back up both together.

The current schema is intentionally a clean break. If the app reports an
incompatible database, reset metadata and caches while preserving source images,
ROI definitions, and exports:

```powershell
python scripts\reset_database.py --yes
```

On Linux/macOS: `python scripts/reset_database.py --yes`

Generated exports can be recreated from frozen versions as long as the source frames and database remain intact.

## Moving the project

Copy the entire project folder except `.venv/`.

On the destination computer, follow [Setup](#setup) for that platform to create a
fresh environment.

Install `requirements-embedding.txt` only if neural scoring is wanted.

A folder that has travelled through a zip archive or a non-POSIX filesystem may
arrive with the executable bit set on every file. Git then reports a mode change
on each one. Suppress it per clone with:

```bash
git config core.fileMode false
```

This setting lives in `.git/config` and does not survive to the next clone.

## Safe testing and development

Never test changes against the real camera folders or production database.

The storage roots can be redirected to temporary directories with:

```powershell
$env:CURATION_CAMERAS_ROOT = "<temporary camera directory>"
$env:CURATION_DATA_DIR = "<temporary data directory>"
```

On Linux/macOS, scoped to a single command:

```bash
CURATION_CAMERAS_ROOT=<temporary camera directory> \
CURATION_DATA_DIR=<temporary data directory> \
.venv/bin/streamlit run scripts/app.py
```

Unset or replace these values before launching the application against real data.

## Troubleshooting

### Performance diagnostics

Performance tracing is disabled by default. To show aggregate timings and workload
counters for the latest view render in the Streamlit sidebar, set:

```powershell
$env:CURATION_PERF_DIAGNOSTICS = "1"
streamlit run scripts\app.py
```

To also append each trace as JSON Lines, set an explicit development log path:

```powershell
$env:CURATION_PERF_LOG = "<temporary or development log path>"
```

For a repeatable classical-scoring baseline that cannot touch production storage,
run:

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_performance.py
```

The benchmark creates temporary camera and database roots internally, compares a
cold and warm feature-cache run, verifies that their score payloads agree, prints
structured JSON, and deletes the temporary fixture on exit.

To compare single-image and bounded neural inference without reading project
images or the database, run:

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_embedding_batches.py --backbone resnet18
.\.venv\Scripts\python.exe scripts\benchmark_embedding_batches.py --backbone resnet50
```

The model is warmed before timing, embeddings are checked for numerical
equivalence, and the fixture exists only in memory.

The classical benchmark accepts worker and decoded-vector batch overrides for
controlled tuning:

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_performance.py --comparison-workers 4 --vector-batch-size 32
```

To compare incremental decoded-vector memory for retain-all and streamed
scoring, run:

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_vector_memory.py
```

Both scripts construct isolated synthetic storage and never access project
camera data or the production database.

To reproduce the storage decision between append/projection writes and direct
SQLite state, plus JSON-versus-SQLite lookup measurements, run:

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_storage_cleanup.py
```

Normal state is stored directly in keyed SQLite tables. Explicit Versions retain
deliberate snapshots; routine label, golden, delete, and mute edits do not grow an
event log or maintain duplicate projections.

To benchmark Status-style filesystem, ROI, product-scope, and summary reads:

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_render_data.py
```

The fixture uses temporary storage. Render snapshots are request-scoped and are
invalidated after ingest, ROI changes, and product-membership changes.

To compare cold/warm thumbnail preparation and encoded cache payloads at
24/48/96 cards, then measure Streamlit's backend grid construction:

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_thumbnails.py
.\.venv\Scripts\python.exe scripts\benchmark_grid_render.py
```

Both scripts create temporary images and storage. The grid result includes the
Python rerun and UI-delta construction but not browser layout and paint time.

To measure folder-ingest time, peak Python memory, and emitted progress phases:

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_ingest.py
```

The benchmark creates its source folder, camera inbox, and SQLite frame catalog under one
temporary directory. Use `--files` and `--mib-per-file` to check other batch
shapes without touching project images.

To reproduce the result-cache format decision across 48, 300, and 1,000 scored
frames:

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_result_serialization.py
```

It compares current JSON, compact JSON, and compressed JSON end to end using a
temporary SQLite database. The production cache remains plain JSON because
compression saves space but does not improve measured persistence or hydration
latency.

### ROI drawing canvas

`streamlit-drawable-canvas` depends on Streamlit internals that have changed
between releases. The ROI editor installs a compatibility shim and falls back to numeric ROI entry if the drawing component cannot run.

### Large uploads

`.streamlit/config.toml` raises Streamlit’s upload and message limits to 4 GB. Run Streamlit from the project root so this configuration is discovered.

### Neural methods are missing

The base application works without PyTorch. If ResNet methods do not appear, activate the intended virtual environment and install the optional embedding requirements.

Check which environment is actually in use before reinstalling. A system-wide
`streamlit` earlier on `PATH` will run the app against the wrong interpreter, so
packages installed into `.venv/` appear to be missing. `which streamlit` should
report a path inside `.venv/bin`; `./run.sh` avoids the problem entirely.

### Scores are absent

Scoring requires at least one golden reference. Leaning and margin require goldens in at least two classes. With only one represented class, novelty can still be calculated.

## Documentation

Current authoritative documents:

- [Current project](docs/current-project.md)
- [Data model](docs/data-model.md)
- [Methodology](docs/methodology.md)

Files under `memory/` and `plans/` may describe earlier
workflows and should be consulted as historical rationale rather than current operating instructions.
