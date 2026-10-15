# Picture Sorter for NN Training

A local web tool (FastAPI backend, React frontend) for preparing compact, reliable image datasets for camera-based vision classification.

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
- Node.js 20+ and npm, to build the web frontend
- No GPU is required for classical scoring (a GPU is optional for ResNet and detector work: Nvidia CUDA, or AMD ROCm on Linux)
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
environment the server can start and then fail on the first missing import,
typically `cv2` or `skimage`. `./run.sh` checks for this and says what to install.

The frontend is built with npm; `./run.sh` does that automatically the first time
(`./run.sh build` rebuilds it after frontend changes).

## Run

From the project root:

```bash
./run.sh
```

then open <http://127.0.0.1:8999>. `run.sh` checks the virtual environment, builds
the frontend on first use, and starts the FastAPI server (uvicorn) from `.venv`.
Extra arguments go to uvicorn, e.g. `./run.sh --port 8510`.

| Command | What it does |
|---|---|
| `./run.sh` | Serve the app (backend + built frontend) on `127.0.0.1:8999` |
| `./run.sh build` | Rebuild the frontend (`app/frontend/dist`) |
| `./run.sh dev` | Backend with auto-reload on 8999 plus the Vite dev server on 5173 (open 5173; `/api` is proxied) |

The server binds `127.0.0.1` only and has **no authentication**; the folder-import
feature reads any directory path it is given. Do not expose it to a network.

On Windows use `.\run.ps1` instead (same modes and arguments); see [Running on Windows](#running-on-windows).

The application provides seven views:

- **Overview** — start page: every camera with its reference frame (ROI boxes drawn on it) and a card per ROI (cutout, products, labeled/golden counts, active version). Click a camera or ROI to make that camera the active one in the left menu; hovering an ROI card highlights its box.
- **Status** — label, golden, version, and ROI-definition summaries
- **Ingest** — add frames and maintain the duplicate index
- **ROI editor** — create, edit, scope, or delete ROIs
- **Dedup** — cluster near-duplicate frames and mute the redundant ones (run before Classify; muted frames are hidden there)
- **Classify** — label frames and compare scoring opinions
- **Insights** — compare method behavior against human labels
- **Versions** — freeze, revert, and export dataset snapshots

The sidebar selects the camera. When a camera has a product-classification ROI, it also selects either the product-sorting stage or one product’s quality stage.

## Running on Windows

> **Not yet tested on Windows.** The Python code uses `pathlib`, and the previous
> (Streamlit) version ran on Windows, so it is expected to work, but only the Linux
> launcher has been exercised. `run.ps1` was written without being run on Windows.
> Report anything that breaks.

From the project folder in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# optional, for ResNet scoring and the Dedup view:
pip install -r requirements-embedding.txt
# optional, for the Detector page's automatic object detection:
pip install -r requirements-detector.txt

# build the frontend once (needs Node.js 20+ from https://nodejs.org)
cd app\frontend
npm install
npm run build
cd ..\..
```

Or use the launcher, which does the checks and the first build for you (same modes as `run.sh`):

```powershell
.\run.ps1            # serve on http://127.0.0.1:8999
.\run.ps1 build      # rebuild the frontend
.\run.ps1 dev        # backend auto-reload + Vite dev server
```

If PowerShell refuses to run it, see *Execution policy* below. To start the server by hand instead:

```powershell
.\.venv\Scripts\python.exe -m uvicorn api.main:app --app-dir app\backend --host 127.0.0.1 --port 8999
```

then open <http://127.0.0.1:8999>. Repeat `npm run build` after any frontend change.
For development with auto-reload, run uvicorn with `--reload` and, in a second
terminal, `npm run dev` inside `app\frontend` (open <http://127.0.0.1:5173>).

Notes:

- **Moving data from another computer:** copy the project folder without `.venv\`
  and `app\frontend\node_modules\`, and create a fresh environment. The data to
  back up is `cameras\` and `data\picture_sorter.db`. If the database is still at
  schema v2, keep `cameras\*\rois.json` until the first launch has migrated it
  (see [Project storage](#project-storage)).
- **Execution policy:** if `Activate.ps1` or `run.ps1` is blocked, run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or start the launcher with
  `powershell -ExecutionPolicy Bypass -File .\run.ps1`. You can also skip activation and call
  `.\.venv\Scripts\python.exe` directly.
- **`run.sh` alternatives:** WSL or Git Bash can run `./run.sh` unchanged.
- **Likely trouble spots:** Windows file locking during ingest, and install failures
  of the PyTorch or UMAP wheels. Install the base requirements first, then add
  `requirements-embedding.txt`.
- The server binds `127.0.0.1` only and has no authentication, as on Linux.

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

## Detector page: filters, mask and object detection

The **Detector** page (sidebar, after the ROI editor) is optional. It changes what the scoring
and Dedup see for one feature (ROI): instead of the whole ROI crop they can see a filtered
crop with everything outside the object blanked. It never changes source frames, labels or
goldens, and the settings are saved per camera and feature. Everything on the page is one
settings set: edit it and press **Save settings** (always visible at the top; **Run detection**
saves first, so it is never blocked).

The page works in four tabs, in working order, each with a status chip (not set / unsaved /
saved / N to review): **Filter → Detector → Review → Mask**. One shared preview sits beside the
tab and follows the step: draw exemplars on it (Detector), adjust the detected box (Review) or
edit the mask shape (Mask). It has a frame picker with ← →, an Original / Filtered / Masked
switch and a frame strip with the detected box drawn on every thumbnail. In Review, **Enter**
accepts the box, **← →** switch frame and **Delete** clears the box. Opening the Mask tab jumps
to the first exemplar's frame, since the mask follows the detected object.

Pipeline for every frame of the feature, in this order:

1. **ROI crop**, as drawn in the ROI editor.
2. **Pre-processing filter** (Gaussian, median, bilateral, box, non-local means, morphological
   open/close, shrink and rescale), with sliders and a live preview. Reduces sensor noise and
   small lighting differences.
3. **Object mask** (rectangle, circle or polygon). Pixels outside it become dark grey. Tick
   **Apply mask to Classify, Dedup and suggestions** to turn it on. Rectangle: drag the corners
   or edges; circle: centre and radius handles; polygon: drag a point, double-click an edge to
   add a point, double-click or right-click a point to remove it (three stay).
4. **Detector** (optional, needs `requirements-detector.txt`): the mask follows the object.
   Mark the object with a box on up to three frames (**exemplars**; vary lighting and screw
   lean), save, then **Run detection**. The detector (OWL-ViT, runs locally; the model is about 600 MB
   and is downloaded only after you confirm a dialog showing the size, source and storage folder) looks for the most similar object in every frame of the feature.
   The mask is drawn on the first exemplar's frame and shifted by how far each frame's
   detected object is from the exemplar's position (translation only, no resizing).

Detections are suggestions. A box is *trusted* when its confidence is at or above the
threshold slider; otherwise it waits in the **review queue**, where you can adjust it, accept
it or clear it. Boxes you accepted or adjusted are never overwritten by a re-run. **Show all
frames, least confident first** lists every frame with the confidence range, so you can
check the confident ones too. Frames without a trusted box keep the mask where it was drawn.

Changing any setting or accepting a box makes cached scores for that feature recompute (only
the affected frames for a moved box). Freezing a version stores the settings in the version
(Versions page, "vision" column); reverting restores labels and goldens, not these settings.
Details: [Data model](docs/data-model.md).

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

**Keyboard shortcuts:** hover a card and press `1`-`9` to set the class in the order of the card's buttons (the same number again removes the label), `0` to clear the label, or the key left of `1` to toggle golden (the frame must be labeled).

Frames can be labeled individually or through an explicitly selected bulk operation.

Labels can be removed the same way: **Clear labels in this view** removes the label from every labeled frame in the current Show filter (all pages, not only the one displayed). Goldens in the view are kept unless you tick the option to clear them too; clearing a golden's label also removes its golden mark. The action asks for confirmation, and a frozen version is the way back.

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

PyTorch comes in one build per machine. The same project folder works on all of
them; only the installed wheel differs, so keep one virtual environment per
machine (or reinstall `torch` when moving):

| Machine | Build | Install |
|---|---|---|
| Any machine, including Windows + AMD | CPU | `pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu` |
| Nvidia GPU (Windows or Linux) | CUDA | the matching build from <https://pytorch.org> |
| AMD GPU on Linux | ROCm | `pip install torch torchvision --index-url https://download.pytorch.org/whl/rocmX.Y` (pick `X.Y` from pytorch.org; support depends on the card model) |

For example, a separate ROCm environment on Linux (leaves `.venv` alone):

```bash
python3 -m venv .venv-rocm
.venv-rocm/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/rocm7.2
.venv-rocm/bin/pip install -r requirements.txt -r requirements-detector.txt
```

Activate it (`source .venv-rocm/bin/activate`) before `./run.sh` to use the GPU.
Check it with `.venv-rocm/bin/python -c "import torch; print(torch.version.hip, torch.cuda.is_available())"`.
If the card is not recognised, try `HSA_OVERRIDE_GFX_VERSION` set to the nearest
supported architecture (for RDNA3, `11.0.0`).

PyTorch has no stable ROCm build for Windows, so a Windows machine with an AMD
card runs the CPU build. CPU inference is fast enough for this tool: on a
16-thread desktop CPU, resnet18 reaches about 157 frames/s and resnet50 about
66 frames/s, so the classical method and the batch sizes in `config.py` remain
the practical limits rather than the model. A GPU mainly helps the object
detector on the Detector page. Measured on a Radeon RX 7800 XT with the ROCm build:
resnet18 about 680 frames/s, resnet50 about 400 frames/s, and detection about
95 ms per frame against 367 ms on the CPU.

The default PyPI wheels carry CUDA libraries that add roughly 2 GB, so prefer
the explicit CPU or ROCm index above on machines without an Nvidia card.

Installing `umap-learn` may downgrade `numpy` slightly, because `numba` pins a
supported range. This is expected; run `pip check` afterwards to confirm the
environment is still consistent.

The application picks the device automatically: it uses the GPU when the installed PyTorch build can see one (CUDA on Nvidia, ROCm on AMD), otherwise the CPU. The Classify and Dedup captions show the result, for example `neural device: AMD GPU (ROCm)`. If a GPU is present on `PATH` (`nvidia-smi` or `rocminfo`) but the CPU-only build is installed, the caption says so; install the matching build above to use it. To force the CPU, set `EMBEDDING_DEVICE = "cpu"` in `app/backend/config.py`.

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

A non-active version can be deleted from the history table (with confirmation). Its snapshot is removed, but the row stays in the history greyed out as "deleted", so version numbers are never reused. Working labels and goldens and files already exported are not touched. The active version cannot be deleted.

### Export

Export materializes a frozen version into class folders under:

```text
cameras/<camera>/exports/<feature>/<version>/<class>/
```

Only the version's golden frames are exported, as unmodified copies of the source images with their original filenames. Labeled frames that are not golden are used for scoring only and are not exported. No cutouts and no extra files are written.

After an export the destination folder is shown with a **Copy path** button for pasting it into another app.

Before copying each frame, the exporter verifies the source-frame content hash. Missing or changed frames are reported.

## Project storage

```text
cameras/
  <camera>/
    unsorted/       immutable source frames
    exports/        generated training-folder exports

data/
  picture_sorter.db

docs/
  current-project.md
  data-model.md
  methodology.md

app/
  backend/          domain + persistence modules, api/ (FastAPI routers), tests/
  frontend/         React + TypeScript UI (src/), built into dist/

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
python app\backend\reset_database.py --yes
```

On Linux/macOS: `python app/backend/reset_database.py --yes`

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
.venv/bin/python -m uvicorn api.main:app --app-dir app/backend --port 8999
```

Unset or replace these values before launching the application against real data.

## Troubleshooting

### Performance diagnostics

Performance tracing is disabled by default. To record aggregate timings and workload
counters, set `CURATION_PERF_DIAGNOSTICS=1` and append each trace as JSON Lines by
setting an explicit development log path:

```powershell
$env:CURATION_PERF_LOG = "<temporary or development log path>"
```

For a repeatable classical-scoring baseline that cannot touch production storage,
run:

```powershell
.\.venv\Scripts\python.exe app\backend\benchmark_performance.py
```

The benchmark creates temporary camera and database roots internally, compares a
cold and warm feature-cache run, verifies that their score payloads agree, prints
structured JSON, and deletes the temporary fixture on exit.

To compare single-image and bounded neural inference without reading project
images or the database, run:

```powershell
.\.venv\Scripts\python.exe app\backend\benchmark_embedding_batches.py --backbone resnet18
.\.venv\Scripts\python.exe app\backend\benchmark_embedding_batches.py --backbone resnet50
```

The model is warmed before timing, embeddings are checked for numerical
equivalence, and the fixture exists only in memory.

The classical benchmark accepts worker and decoded-vector batch overrides for
controlled tuning:

```powershell
.\.venv\Scripts\python.exe app\backend\benchmark_performance.py --comparison-workers 4 --vector-batch-size 32
```

To compare incremental decoded-vector memory for retain-all and streamed
scoring, run:

```powershell
.\.venv\Scripts\python.exe app\backend\benchmark_vector_memory.py
```

Both scripts construct isolated synthetic storage and never access project
camera data or the production database.

To reproduce the storage decision between append/projection writes and direct
SQLite state, plus JSON-versus-SQLite lookup measurements, run:

```powershell
.\.venv\Scripts\python.exe app\backend\benchmark_storage_cleanup.py
```

Normal state is stored directly in keyed SQLite tables. Explicit Versions retain
deliberate snapshots; routine label, golden, delete, and mute edits do not grow an
event log or maintain duplicate projections.

To benchmark Status-style filesystem, ROI, product-scope, and summary reads:

```powershell
.\.venv\Scripts\python.exe app\backend\benchmark_render_data.py
```

The fixture uses temporary storage. Render snapshots are request-scoped and are
invalidated after ingest, ROI changes, and product-membership changes.

To compare cold/warm thumbnail preparation and encoded cache payloads at
24/48/96 cards:

```powershell
.\.venv\Scripts\python.exe app\backend\benchmark_thumbnails.py
```

The script creates temporary images and storage.

To measure folder-ingest time, peak Python memory, and emitted progress phases:

```powershell
.\.venv\Scripts\python.exe app\backend\benchmark_ingest.py
```

The benchmark creates its source folder, camera inbox, and SQLite frame catalog under one
temporary directory. Use `--files` and `--mib-per-file` to check other batch
shapes without touching project images.

To reproduce the result-cache format decision across 48, 300, and 1,000 scored
frames:

```powershell
.\.venv\Scripts\python.exe app\backend\benchmark_result_serialization.py
```

It compares current JSON, compact JSON, and compressed JSON end to end using a
temporary SQLite database. The production cache remains plain JSON because
compression saves space but does not improve measured persistence or hydration
latency.

### ROI drawing canvas

The ROI editor is a pointer-driven overlay on the frame image (draw, move, and
resize with handles) and always offers numeric `x / y / w / h` fields as well.

### Large uploads

Uploads are streamed to a temporary staging folder and ingested by a background job,
so file size is limited by disk space, not memory. Folder import avoids the copy
entirely and is the better choice for very large batches.

### Neural methods are missing

The base application works without PyTorch. If ResNet methods do not appear, activate the intended virtual environment and install the optional embedding requirements.

Check which environment is actually in use before reinstalling. Running
`uvicorn` or `python` from outside `.venv/` uses the wrong interpreter, so packages
installed into `.venv/` appear to be missing; `./run.sh` always uses `.venv/bin/python`.

### Scores are absent

Scoring requires at least one golden reference. Leaning and margin require goldens in at least two classes. With only one represented class, novelty can still be calculated.

## Documentation

Current authoritative documents:

- [Current project](docs/current-project.md)
- [Data model](docs/data-model.md)
- [Methodology](docs/methodology.md)

Files under `memory/` and `plans/` may describe earlier
workflows and should be consulted as historical rationale rather than current operating instructions.

## Version

The app version and release date are shown under the title in the sidebar and served at `GET /api/version`. Bump `VERSION` and `RELEASED` in `app/backend/appinfo.py` with every code change (ISO date; last number for small changes, middle number for new features). Scheme: `0.x.y` was the Streamlit generation, `1.x.y` is the current FastAPI + React application.
