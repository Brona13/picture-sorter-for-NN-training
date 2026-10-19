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

The application provides these views:

- **Overview** — start page: every camera with its reference frame (ROI boxes drawn on it) and a card per ROI (cutout, products, labeled/golden counts, active version). Click a camera or ROI to make that camera the active one in the left menu; hovering an ROI card highlights its box. Each card also shows its pipeline stages (see *Pipeline stages and the step bar*).
- **Status** — label, golden, version, and ROI-definition summaries
- **Ingest** — add frames and maintain the duplicate index
- **Dedup** — cluster near-duplicate frames and mute the redundant ones (right after Ingest, before Classify; muted frames are hidden there)
- **ROI editor** — create, edit, scope, or delete ROIs (zoom with the wheel, pan with the middle button or Space + drag; deleted frames are not offered)
- **Edge angle** — a rule-based check of one edge's angle and direction (see *Edge angle rule* below)
- **Classify** — label frames and compare scoring opinions
- **Configuration** (⚙️, bottom of the menu) — tick which scoring methods (CPU, ResNet18, ResNet50) take part in the flow; see *Choosing the scoring methods*
- **Verdict** (⚖️) — one OK / NG verdict per picture from all ROIs; decide contradictions and stale decisions (see *Project verdicts*)
- **Insights** — compare method behavior against human labels; click a confusion-matrix number to review those frames as cards (false positives / negatives)
- **Augmentation** — measure how far the object moves between frames and keep movement ranges for the training side (see *Augmentation ranges* below)
- **Versions** — freeze verdicts as project versions and export them; freeze and revert ROI snapshots

The top bar selects the camera. When a camera has a product-classification ROI, it also selects either the product-sorting stage or one product’s quality stage.

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

## Create a camera and tag it

On the **Overview** page press **➕ New camera**: give it a name and optional tags, then **Create and add pictures →**
opens Ingest on the new camera. Tags are free text and belong to one camera (a project); typing suggests tags already
used on any camera, **×** removes a tag from that camera only, and the tag buttons above the camera cards filter
the Overview (click a tag once to require it, again to exclude it, a third time to clear: a camera must carry every required tag and none of the excluded ones). Tags only describe and filter cameras.

### Delete a camera

Each camera on the Overview has **🗑 Delete camera…**. The warning lists what would go (the files and their size on disk, the pictures, ROIs, labels, goldens, versions and other records), and the button stays disabled until you type the camera's name again. Deleting removes everything related to the camera: its folder (pictures and exports), every database record of every page, and the cached vectors that belong only to it. **There is no trash and no undo**, and a camera with a job still running refuses it.

## Add images

Use the **Ingest** view (select a camera first; new ones are created on the Overview page).

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

**Products.** Under *Products — classes of …* every product has its own field. Change a name to **rename** the product:
its labels, goldens, versions and the ROIs that belong to it (`<product>::<roi>`, and the shared ROIs that list it) stay
connected, and the Chain boxes keep their place. **+ Add product** adds one; **✕** takes one off the list (its labels and
ROIs stay, they are just not offered). To swap two names, rename one of them first. Exports already written keep the old names.

## The Chain page

**Overview → Chain** draws the processing chain of the selected camera as boxes and arrows: **Ingest → ROI product →
Classify → ROI feature → Classify**. It is a map of your ROIs, not a second copy: a box is Ingest, one ROI, or the Classify
(labeling) step of an ROI, and the arrows come from the ROIs themselves.

- The product ROI's **Classify** box shows the pictures per product and how many are not labeled yet, and has **one handle
  per product**. Drag from a product handle to a feature ROI to scope that feature to the product (several handles = several
  products); drag from Ingest to put it back on the whole camera. Deleting an arrow removes that product.
- **+ ROI product** (type at least two product names) and **+ ROI feature** add real ROIs. Click a box to rename it (double-click
  its name; this is only a display name), to open its **ROI editor** or **Classify** page, or to **Delete…** it (a warning
  lists the labels, goldens, detections and versions that would go).
- **ROI editor** and **Classify** open locked to that one ROI (no ROI list, no creating other ROIs, only its own rectangle) with
  **← Back to chain**; the same pages from the menu keep their ROI selector.
- Wheel zooms, drag pans, the corner button fits the whole map. Box positions and names are remembered per camera.


## Pipeline stages and the step bar

Every ROI card on the **Overview** page shows how far that ROI has got, and the same strip appears as a
slim **step bar** above the pages that work on one ROI. A green chip is a finished stage, an outlined
bold chip is the next required one, a dashed chip is optional, and a warning chip is out of date.
Click any chip to open the page that does that stage, already on that ROI (and its product):

| Stage | Done when | Page |
|---|---|---|
| ROI | the ROI exists | ROI editor |
| Filter & detector (optional) | a filter, a mask or detector exemplars are set | Detector |
| Dedup (optional) | frames were muted or a clustering was applied | Dedup |
| Labels | every class has at least one labeled frame (in progress before that) | Classify |
| Goldens | every class has at least one golden frame | Classify |
| Scores | the scores were refreshed and the goldens have not changed since (out of date if they have) | Classify |
| Edge angle (optional) | a line is saved and all frames are measured for it | Edge angle |
| Augmentation (optional) | movement ranges are saved | Augmentation |
| Version | a version is frozen and not deleted | Versions |
| Export | the latest project version (verdicts) of the camera was exported | Versions |

The bar under each card also shows how many of the ROI's frames are labeled. A curated dataset keeps many
frames unlabeled on purpose, so the bar is information, not a target. Nothing is stored for this: every
stage is worked out from what the other pages already keep, so it cannot disagree with them. The step bar
reloads when you change page, ROI or camera, not while you work on one page.

## Augmentation ranges

The **Augmentation** page answers one question for an ROI: how far does the object move between
frames? It measures and records only. It does not create, change or export any picture; applying
shifts or rotations is the job of the training system, and this tool gives it the ranges.

1. Pick the ROI and a **reference frame**: a typical OK frame where the object sits where it should
   (by default the first golden, else the camera's reference frame). Every frame is compared with it.
2. Choose where the **shift** comes from: the stored detector box when the frame has a trusted one
   (see the Detector page), otherwise matching the two pictures (after the feature's filter). "Detector
   box only" and "picture matching only" restrict it. Tick **Measure rotation** to estimate each frame's
   rotation too; it is only reliable for a few degrees. A rotated frame still gets the correct shift.
3. Click **Measure all frames** (it saves first if you changed something). It takes a few milliseconds
   per frame once the pictures are read.
4. Each axis shows a histogram, the minimum, maximum and median, and the central part of the values
   (set **Cover the central N% of the frames**, default 95%) as the suggested range. **Use frames** can
   restrict the statistics to the frames labeled with one class, for example only OK. Shifts are in pixels
   of the ROI crop (right and down positive; the percentage of the crop is shown); rotation is in degrees,
   counter-clockwise on screen positive. Frames that could not be measured (no clear match) are counted
   but left out.
5. **Use suggested** copies the suggestion into the editable range; adjust it by hand if you know better,
   then **Save**. Changing the range, coverage or class filter needs no new measurement; changing the
   reference frame, the shift source, the rotation option, the feature's filter or its detector does.

Freezing a version records the saved ranges, the reference frame and the crop size in the version's
statistics; the Versions page lists them in the *rules & ranges* column. Exports are unchanged: class
folders with the original filenames and no extra file.

## Edge angle rule

The **Edge angle** page is a rule-based tool for ROIs where one edge decides OK or not OK: only one
angle **and** one direction are good, any other angle or the opposite direction is not. It gives its
own opinion, separate from the embedding scores, and is never blended with them.

1. Choose the ROI (first row, with the **Picture size** slider) and a frame (second row, so long file
   names have room). Click once on the crop to place the first point of a line along the edge (the
   line follows the cursor), click again for the second point. A band appears around the line; drag
   the red ends to adjust the line and the orange handle on one long side to resize the band, or use
   the **Band half-width** slider. Esc cancels a line you have started.
   The crop sits in a bordered box you can zoom: the **mouse wheel** zooms at the cursor, the
   **−**, **+**, **Reset** (fit) and **1:1** (one picture pixel per screen pixel) buttons or the keys
   `-`, `+`, `0` do the same around the centre. Pan with the **middle button** or **Space + drag**,
   or, once the line is drawn, by dragging the background. The percentage shows screen pixels per
   picture pixel (above 300% the picture is drawn without smoothing so single pixels are visible),
   and the tool row shows the pixel under the cursor and the line's angle and length. Zoom and
   position stay when you change frame and start fitted again when you change ROI or camera. Drawing
   and dragging work at any zoom.
2. The **Band preview** shows the band straightened, with the points that were found (yellow) and the
   fitted line (green); the same points are drawn on the crop. **Points used** sets how many points
   feed the fit (the band is cut into that many slices along the line and the strongest edge in each
   slice is kept). Start with 5 and raise it if the angle jumps between frames. Adjust until the green
   line matches what your eye sees.
3. The measurement shows the **angle** (0-180°, counter-clockwise on screen) and the **direction**:
   `+` when the side to the left of that angle is brighter, `-` when the right side is. Direction comes
   from the picture, not from the order of your clicks. Only edges within 45° of your line are used.
4. Pick a frame that is OK and click **Use this frame as the OK example**; this fills the expected
   angle and direction. Set the tolerance (±°). A frame passes when its angle is within the tolerance
   and the direction is the same; otherwise it fails. A frame with no usable edge is *undetermined*.
5. **Save**, then **Measure all frames**. The results are kept as metadata (derived, recomputed when the
   line, band, number of points or the feature's filter changes; changing only the expectation or
   tolerance needs no new run). In Classify every measured card shows a badge such as `∠ 90.3° + · pass`,
   and **Show: Edge angle: pass / fail / undetermined** filters the grid. Freezing a version records the
   rule's settings and counts in the version's statistics.

The rule needs no PyTorch. Measuring a frame takes a few milliseconds, so a run is limited by reading
the images.

## Detector page: filters, mask and object detection

The **Detector** page (Manipulation tools, after the ROI editor) is optional. It changes what the scoring
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
4. **Detector** (optional): the mask follows the object. Mark the object with a box on up to three
   frames (**exemplars**; vary lighting and screw lean), save, then **Run detection**. There are two
   **methods**:
   - **Template matching** (the default, fast, no model): slides your exemplar crop over every frame and reports
     where it matches best. The box has exactly the size you drew and the position is the best match; the
     confidence is the real similarity (1 = identical), so the threshold slider means something. It suits a
     fixed camera and an object of constant size. It copes with small changes in light, but not with a
     rotated, scaled or differently seen object. About 1.5 ms per frame on the CPU.
   - **Model** (OWL-ViT, needs `requirements-detector.txt`, runs locally; the model is about 600 MB and is
     downloaded only after you confirm a dialog showing the size, source and storage folder): looks for
     the most similar object in every frame and tolerates a different look, but its boxes are often much
     bigger than the object (so the stored box takes your drawn size, centred where the model put its own box),
     and its confidence is only relative to the frame's best box. The **Input size** choice (768 precise,
     512 about twice as fast, boxes less exact) belongs to this method.

   The mask is drawn on the first exemplar's frame and shifted by how far each frame's
   detected object is from the exemplar's position (translation only, no resizing). Changing the method
   (or the exemplars, or the model's input size) makes the stored detections stale, so run again.

Detection always runs on the filtered pictures: the filter you set on the Filter step is applied to every frame and to your
exemplars before anything is detected, by both methods (Run saves unsaved settings first, and changing the filter makes the
stored detections stale).

Detections are suggestions. A box is *trusted* when its confidence is at or above the threshold slider; otherwise it waits
in the **review queue**, a paged grid of cards like the other pages. Each card shows the frame with the detected box drawn
on it, its state and confidence, and four icon buttons (hover them for what they do and the key): **✓** accept the box,
**✕** clear the box, **🗑** delete the picture (the same soft delete as everywhere) and, once there is something to undo,
**↶**. Keys on the card under the mouse: **Enter** or **A** accepts, **X** clears the box, **Delete** deletes the picture,
**Z** undoes (a decision, or a delete), **E** (or a click on the picture) opens the viewer to adjust the box: drag it, drag
the corners or draw a new one, then **Enter** accepts and moves to the next card, **← →** switch card and **Esc** closes.
**Hold A** (or **X**) and move the mouse across the cards to accept (or clear) every card the pointer enters, once, exactly like
painting labels on Classify (a green tick or red cross follows the mouse while the key is held); cards you already decided
are left alone, and deleting and undoing are never painted. A decision shows at once and the card stays where it is,
marked as decided or deleted (dimmed), until you press **Remove them**, change the filter or leave the step.

**Show** picks which frames are listed, with how many each has: *Needs review* (the default), *Unsure*, *No detection*,
*Trusted*, *Accepted*, *Adjusted by me* or *All frames*. **Sort** orders them: least or most confident first, by file name,
or by how far the detected box is from the first exemplar's position (furthest first is a quick way to spot a box that
landed somewhere odd). Both choices are remembered. Boxes you accepted or adjusted are never overwritten by a re-run.
Frames without a trusted box keep the mask where it was drawn.

Changing any setting or accepting a box makes cached scores for that feature recompute (only
the affected frames for a moved box). Freezing a version stores the settings in the version
(Versions page, "vision" column); reverting restores labels and goldens, not these settings.
Details: [Data model](docs/data-model.md).

## Project verdicts

A picture has one **verdict**, OK or NG, for the whole camera. It is built from the OK and NG labels that the
quality ROIs gave the picture (labels from Classify, bulk and auto-assign, Dedup, Find similar and so on all count
the same; classify-role ROIs and other classes are ignored for now):

- no ROI labelled it: **open**;
- every ROI that labelled it says the same: that verdict, **automatic and final**;
- any other mix (some OK, some NG): **contradiction**. NG does not win on its own.

The **⚖️ Verdict** page lists the pictures by state (it opens on contradictions). Each card shows what every ROI said,
how it was labelled (manual, bulk, auto) and on which page. Press OK or NG to decide; your decision stands until a label
of that picture changes, then it is marked **stale** and waits for **Keep** or a new decision. **Clear** drops your
decision and the rule applies again. Deleted pictures are left out.
Hover a card and press `1` (OK), `2` (NG) or `0` (clear my decision); hold one of them and move the mouse across the cards to
paint the decision onto every card the pointer enters (a dot in the class colour follows the mouse), like labeling on Classify.
A sweep only decides cards you have not decided, and `0` only clears cards you have, so it never overrides a decision of yours.

Each camera card on Overview carries a bar with the pictures that have a verdict, open, contradictions, stale and
**duplicates** (open pictures muted by Dedup, they need no label), plus the number of **deleted** pictures.
Pictures are exported from the verdicts (see *Freeze and export versions*).

## Choosing the scoring methods

The **⚙️ Configuration** page (the cogwheel at the bottom right of the left menu; click it again to return to the page you came from) has one checkbox per scoring method: CPU,
ResNet18, ResNet50. The choice is global (all cameras) and saved at once. A method that is off:

- is not computed, so **Refresh scores** is faster (no ResNet pass at all if both ResNets are off);
- has no flag on the Classify cards (the bars per class stay), and disappears from Insights and the
  ranking choices; the ResNets also drive Dedup, Outliers and Find similar, which use only the ones that are on;
- loses nothing: cached vectors and scores stay, so switching it back on needs one **Refresh scores**
  (Classify says so).

At least one method must stay on. On the cards each method shows as a coloured flag containing its tag
(**CPU**, **R18**, **R50**); the colour is the class that method leans to, and a grey flag means no leaning yet.
The "Methods disagree" view needs two or more active methods.

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

**One way of working on every card grid.** The Classify, Insights, Scatter, Clusters, Outliers, Verdict and Detector-review grids behave
the same: hover a card and press its key to act on it; hold a key and move the mouse across the cards to paint the action
onto each one the pointer enters (once per stroke, never on a scroll), with the mouse cursor changing to a dot in the
action's colour from the moment the key goes down, on top of links and buttons too. Only the keys, the colours and what an
action does differ by page.

**Keyboard shortcuts:** hover a card and press `1`-`9` to set the class in the order of the card's buttons (the same number again removes the label), `0` or `X` to clear the label, `Delete` to delete the picture, or the key left of `1` to toggle golden (the frame must be labeled). The buttons show only the labels; the key is in their hover hint. **Hold a key and move the mouse across the cards** to do the same to each one: a class key labels only the *unlabeled* cards, `0` / `X` clears labeled non-golden cards, `Delete` deletes unlabeled non-golden ones. A sweep never overwrites an existing label (clear it first, then paint), and a golden is never touched.

**Deleting fades, it does not reflow.** A deleted card fades and stays where it is, with a Restore button, so nothing moves while you work; it drops out when you turn the grid (another page, page size, columns, View or search). The numbers above the grid count only the pictures you work with (not deleted, not hidden by duplicate removal).

### The Classify page

- **Numbers.** Above the grid, boxes show *Frames* ("of N" when the ROI covers only some products), one box per class of the ROI (the products on the product ROI, OK / NG on a feature, in the class colours) with its golden count, and *Unlabeled*. Click a box to see those pictures.
- **View switch.** **Grid** (the default), **Scatter** (a 2D map: drag a rectangle to select many pictures, then label or delete them in one click) and **Outliers** (the most unusual pictures first). **🔄 Refresh scores** sits on the same line while the Grid is shown.
- **Options panel** (right, `»` collapses it). It shows the selected view's properties: Show / Order by / the bulk tools for the Grid, embedding, projection and colour for Scatter, embedding, k and *Score outliers* for Outliers.
- **Rank using** (ResNet 50 / 18 / Classical) is in the top bar next to Camera and Product.
- **Search by file name.** The magnifying glass in the pager (top and bottom) filters the cards by part of a file name. In Classify's grid it searches the **whole camera**, deleted, hidden and out-of-scope pictures included. A picture outside the ROI's scope has a red frame (hover for its product), a hidden one a dark grey dashed frame. Click it: in a feature ROI the viewer shows a **Product** row (see and correct the product) next to the **Feature** buttons (OK / NG); a hidden picture has **Show again**. The bulk tools are off while a search is active.

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

### Find similar (batch labeling from one example)

On a labeled Classify card, the **🔍≈** button opens a *Find similar* panel (it needs the ResNet
methods; the button is greyed out on an unlabeled card). Pick the embedding and how many frames to
show (30-250), then click **Find similar**. The panel lists the **unlabeled** frames of the same ROI
nearest to that card, closest first, with their cosine distance. Nothing is ticked at first. Move the
**Distance** slider to tick everything up to that distance, or tick pictures one by one, then click
**Label N ticked as <class>**. Only the seed's label is applied, goldens are never created, and
frames labeled, deleted or muted since the list was made are skipped and reported. The filter and mask
of the feature apply, as in Dedup. This is separate from *Bulk label* and *Auto-assign*, which select
by leaning, margin or novelty against the goldens.

### The Dedup page

Dedup is three tools in the **Manipulation** bar, under the label **Duplicates**: **Scatter**, **Clusters**
and **Outliers**. Pick one at the top; the centre shows its results and the **options panel** on the right
shows its controls (the `»` button hides the panel; the choice is remembered). When the panel is long it
scrolls on its own, independently of the centre. At its top a card shows how many frames are in scope.

- **Panel, top to bottom:** Embedding, Feature (ROI), then the selected tool's controls. Hover the small
  **i** icon in the tool's title row for what it does. The product is chosen in the top bar.
- **One tool at a time.** Switching tools does not lose results: they show again at once when you come back,
  unless the ROI or the embedding changed.
- **Clusters:** Epsilon and Min points sliders (they also move with the mouse wheel), **Cluster**, **↺**
  (revert the sliders to the last clustering) and **🔇** (apply mute: mute every cluster member except its
  representative; nothing is deleted, labeled and golden frames are never muted), with a line telling how many
  frames would be muted. The centre shows a row of tabs, `0 (12)`, `1 (5)` ... and `Unique (3)`, and the
  paged card grid of the chosen tab. Mark another card as the cluster's representative with its `○ rep` button.
- **Scatter:** a 2D map of the frames (UMAP or t-SNE), colourable by cluster, label, outlier score or nothing.
  It does not need a clustering. Drag a rectangle to zoom in and select; below the map you get class-coloured
  "Label N as X" buttons, a "Delete these N frame(s)…" button (asks first) and the paged card grid of the
  selection. Right-click resets the view.
- **Outliers:** choose *k* (1-20, default 5, mouse wheel works) and press **Score outliers**. Each frame gets its
  mean cosine distance to its *k* nearest other frames on the same embeddings (filter and mask apply). The most
  isolated frames come first as cards. The score is a hint for review, not a verdict; it is computed on demand
  and nothing is stored. Colour the scatter by it with *Colour by: Outlier score*.
- **Picture viewer:** one viewer for every page that shows pictures: the Scatter selection, Clusters, Outliers,
  Insights, Classify, Verdict and the Detector's review. Clicking a card's picture opens the full frame in an overlay
  instead of a new tab (Ctrl or middle click still opens a tab). ← → walk the pictures in grid order (on Classify
  and Verdict: the page you are on), the wheel zooms (kept when you move to the next picture), dragging pans,
  **Reset** and **1:1** are in the toolbar, the feature's ROI is outlined in yellow (**▭** hides it), and the file
  name sits under the picture. Each page adds its own actions: on the labeling pages the card keys work on the
  shown picture (1-9 label, 0 clears, the key left of 1 is golden, Delete deletes; a deleted frame can be restored),
  on Verdict 1 decides OK, 2 NG and 0 clears the decision, and on the Detector review the viewer edits the
  detected box. Esc closes.

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

`./run.sh` uses `.venv-rocm` automatically when it exists; set `PICTURE_SORTER_VENV=.venv` to force the CPU environment.
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
95 ms per frame against 367 ms on the CPU (before v1.45.2; the detector has since been made much
faster, about 37 frames/s at the default size and about 85 frames/s at the 512 input size on synthetic
250 x 250 frames: `python app/backend/benchmark_detector.py`).

The default PyPI wheels carry CUDA libraries that add roughly 2 GB, so prefer
the explicit CPU or ROCm index above on machines without an Nvidia card.

Installing `umap-learn` may downgrade `numpy` slightly, because `numba` pins a
supported range. This is expected; run `pip check` afterwards to confirm the
environment is still consistent.

The application picks the device automatically: it uses the GPU when the installed PyTorch build can see one (CUDA on Nvidia, ROCm on AMD), otherwise the CPU. The Classify and Dedup captions show the result, for example `neural device: AMD GPU (ROCm)`. If a GPU is present on `PATH` (`nvidia-smi` or `rocminfo`) but the CPU-only build is installed, the caption says so; install the matching build above to use it. To force the CPU, set `EMBEDDING_DEVICE = "cpu"` in `app/backend/config.py`.

The first neural run downloads pretrained weights — about 45 MB for resnet18
and 98 MB for resnet50 — into the PyTorch cache, once per machine.

## Freeze and export versions

The **Versions** page has two kinds of versions.

### Project versions: freeze and export the verdicts

At the top of the page, **Project versions (verdicts)** freezes the camera's verdicts (see *Project verdicts*).
The verdict is the decision step; what is exported is the **golden** pictures. The **Only goldens** box (on by default)
freezes only pictures that are golden (OK or NG) in at least one ROI and have a valid verdict, in the OK or NG folder
their verdict says; the line under the form says how many that is and how many verdict pictures are left out for
having no golden mark. Untick the box to freeze every picture with an OK or NG verdict instead. Frozen pictures are
stored with their content hash. Open pictures,
contradictions, stale decisions and Dedup duplicates have no valid verdict and are left out; a warning above the
form says how many. Deleted pictures are never in a version. Versions are numbered p1, p2, ...; the newest is
"latest". An older one can be deleted (confirmation); the row stays greyed out and the number is not reused.
Project versions cannot be reverted, because verdicts are derived from the labels.

**Export** copies the OK and NG pictures of a project version, unmodified and with their original filenames, into

```text
cameras/<camera>/exports/project/v<NNN>__<name>/OK/
cameras/<camera>/exports/project/v<NNN>__<name>/NG/
```

No cutouts and no extra files are written. After an export the folder is shown with a **Copy path** button.
Before copying each frame the exporter verifies its content hash; missing or changed frames are reported, not
silently skipped. Exporting again from the same version gives the same result, whatever the labels are now.

### ROI versions: freeze and revert

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

ROI versions are snapshots for going back; they are not exported (this changed in v1.27.0, when export moved
from goldens to verdicts).

### Downstream results

The training or inspection system that uses an exported dataset measures its own quality values (for
example accuracy, or the recall of NG). This tool does not compute them, but the **Downstream results**
section under the project versions records them against the project version the dataset came from, so you
can see which curation choices led to which outcome.

- **Record a result:** choose the version (the active one by default, a deleted one is possible too), type
  a metric name (earlier names are suggested; free text), the number, the day it was measured (today by
  default) and an optional note, then **Record**. Several values per metric are allowed, for example one per
  training run; the newest measurement counts as the latest.
- **Compare:** a table lists each metric against the versions that have a value (hover a cell for the date
  and note). Edit or delete a single entry with the pencil and bin buttons.
- Results stay with a version even after it is deleted, and they are never used for scoring or ranking.

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

The app version and release date are shown at the right of the status bar at the bottom and served at `GET /api/version`. Above them a small badge says which device the neural parts run on (AMD GPU, NVIDIA GPU or CPU only, with the card's name; `GET /api/device`); click it to change its look. The application remembers the last camera, product, ROI and page in the browser. Bump `VERSION` and `RELEASED` in `app/backend/appinfo.py` with every code change (ISO date; last number for small changes, middle number for new features). Scheme: `0.x.y` was the Streamlit generation, `1.x.y` is the current FastAPI + React application.
