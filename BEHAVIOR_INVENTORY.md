# BEHAVIOR_INVENTORY

Read-only audit of the currently implemented user-visible behavior of the
Picture Sorter for NN Training. Every entry describes what the code actually
does today, based on reading the modules under `scripts/`. Anything I could not
verify by reading the code is called out explicitly (typically in the
"observed, not confirmed" sections at the end of each view).

> Terminology in this doc:
> - **camera** — top-level scope (`cameras/<camera>/`).
> - **feature** — a named ROI. A product-scoped feature is written
>   `"<product>::<roi>"` via `datamodel.FEATURE_SEP`.
> - **role** — an ROI is either `"quality"` (default) or `"classify"` (product-
>   sorting).
> - **golden** — a labeled frame marked as a class reference. Invariants are
>   enforced transactionally in `scripts/labels.py`.

---

## 0. Sidebar (global chrome)

Implemented in `scripts/app.py`.

- Title: `🖼️ Picture Sorter`.
- **Camera** selectbox: populated by `datamodel.list_cameras()` (directories
  under `config.CAMERAS_ROOT`, sorted). If none exist, the page shows a warning
  telling the user to create `cameras/<camera>/unsorted/` and stops rendering.
- **Product** selectbox: appears only when the current camera has a
  `role="classify"` ROI. The first option is the pseudo-label
  `"▣ All frames — product sort"`; selecting it means `product = None` (Stage 1).
  Selecting a product name means `product = <that>` (Stage 2). A caption below
  the selector switches between:
  - "Stage 1 — sort every frame into a product." (no product chosen)
  - "Stage 2 — quality (OK/NG) within **<product>**." (product chosen)
- **View** radio: `Status`, `Ingest`, `ROI editor`, `Dedup`, `Classify`,
  `Insights`, `Versions`. (Note: `app.py`'s docstring lists five views;
  the actual list is seven.)
- A `Cameras root:` caption always shows the resolved `CAMERAS_ROOT` path in
  code font.
- **Performance diagnostics expander** (bottom of sidebar): only rendered if
  `CURATION_PERF_DIAGNOSTICS` is truthy. Shows the last render's total
  duration in ms, a spans table (sorted by total ms desc), and a collapsed
  `st.json` of counters. If `CURATION_PERF_LOG` is also set, `perf.emit_trace`
  appends each completed trace as one JSON line to that path.
- **Page config**: `layout="wide"`, page title `"Picture Sorter for NN Training"`.
  Set once before any view module is imported.
- **Database reset guardrail**: if any view raises
  `db.DatabaseResetRequired`, the app shows the exception text and a copyable
  `python scripts/reset_database.py --yes` code block, then stops.
- **Render-scoped snapshot**: every view render happens inside
  `datamodel.render_snapshot()` and `perf.trace(...)`, so read-only listing
  helpers (cameras, unsorted files, ROIs, product membership, per-feature
  frame sets) are memoized for the render and invalidated by explicit
  mutation calls in `labels`, `ingest`, and `datamodel.save_rois`.

---

## 1. Status view (`scripts/view_status.py`)

### User-visible purpose
A single per-camera dashboard: how many frames, how many ROIs/products, and a
per-feature table of label/golden counts, version count, and active version.

### Behavior in detail
- Header: `Status — <camera>`.
- Three metric tiles: **Frames**, **Features (ROIs)**, **Products**. The
  Products tile displays `"—"` when the camera has no classification ROI
  (empty product list).
- Subheader "Features (ROIs)". If the camera has no ROIs at all, shows an
  info box pointing to the ROI editor and returns early.
- Otherwise renders one dataframe with one row per ROI (`st.dataframe`,
  `width="stretch"`, `hide_index=True`):
  - `product` — computed scope description:
    - `"(defines products)"` for the classify ROI.
    - `"<product>"` for a `product::name` feature.
    - `"🔗 <p1>, <p2>, …"` for a camera-level ROI restricted to specific products.
    - `"— all"` otherwise.
  - `feature` — the short ROI name (product prefix removed).
  - `role` — `"quality"` or `"classify"`.
  - `labeled` — a per-class summary joined by `" · "` (e.g. `"OK: 3 · NG: 1"`);
    `"—"` if no classes.
  - `⭐ goldens` — same shape, golden counts per class; `"—"` if none.
  - `unlabeled`, `of` (= total frames in this feature's scope), `versions`
    (count), `active` (either `"v<N>"` or `"—"`).
- Data source: `labels.current_states_for_features` returns labels and goldens
  for all features in a single pair of `IN (...)` queries;
  `versions.summaries` returns version count + active number in a single
  grouped query. This is the only place both bulk endpoints are wired up
  today.

### Inputs / outputs
- Input: current camera (from sidebar). The Product selector is ignored:
  Status intentionally lists every feature of the camera, regardless of the
  Stage 1/2 scope.
- Output: read-only display. No writes.

### Observed, not confirmed with user
- Class order in the `labeled` / `goldens` columns is the ROI's own class list
  when present, else `config.CLASSES` (`["OK", "NG"]`). Extra classes seen only
  in current labels (e.g., leftover from a former class list) are counted
  inside `labels.counts` but not shown in Status because Status only iterates
  the ROI's declared classes. This means Status can under-report the total of
  labels if the ROI class list was ever shrunk while old labels still exist —
  the `unlabeled` count still comes out correct because `labels.counts` uses
  the union set internally.
- The Products metric shows `"—"` (a string) even when a camera has one
  product-classification ROI with zero products; the classify-ROI creation
  form enforces "at least two products", so this state should be unreachable
  through the UI but is not defended against here.

---

## 2. Ingest view (`scripts/view_ingest.py`)

### User-visible purpose
Add frames to `cameras/<camera>/unsorted/` by upload or folder path, with
content-hash duplicate detection. Also creates cameras and rebuilds the frame
catalog.

### Behavior in detail
- Header: `Ingest — <camera>`. The Product selector is deliberately ignored
  (frames belong to the camera, not a product).
- Caption: "Add images to this camera. Duplicates are detected by file
  **content** (not filename), so the same picture is never ingested twice."
- **"Ingest report" one-shot**: if the previous ingest run stashed a report
  (`ui_common.INGEST_REPORT_KEY` in session state), the view pops it and shows:
  - Success banner: `Added **<n>** to **<target>**` and, if duplicates were
    skipped, ` · skipped **<n>** duplicate(s)`.
  - Collapsed expander listing skipped duplicate original filenames.
  - Errors block (if any) as bulleted list.
  Each report is displayed exactly once.
- Metric tile: **Frames in this camera** — `len(datamodel.list_unsorted(...))`.

- **Upload section** (target = `"unsorted"`, label = `"frames"`):
  - Streamlit form with `clear_on_submit=True` and a file uploader:
    - `accept_multiple_files=True`.
    - `type` = extensions from `config.IMAGE_EXTENSIONS`
      (`jpg, jpeg, png, bmp, tif, tiff, webp`), without the dot.
    - Submit button labelled `➕ Add frames`.
  - On submit:
    - If files were selected: creates an `_IngestProgressUI` `st.status`
      titled `"Preparing <n> upload(s)…"`, calls `ingest.ingest_files` with a
      streaming progress callback, then stashes the report and `st.rerun()`.
    - If nothing was selected: shows `st.warning("No files selected.")`.

- **Folder path expander** ("…or import from a folder path on this computer"):
  - Text input `Folder path`.
  - Button `Import folder`:
    - If the text is non-empty: `_IngestProgressUI("Scanning folder…")` then
      `ingest.ingest_folder`.
    - Empty: `st.warning("Enter a folder path.")`.
  - Folder walks are non-recursive (`folder.iterdir()`) and filtered by
    extension.

- **Live status widget** during ingest (`_IngestProgressUI`):
  - Single `st.status` container with an `st.progress` bar inside.
  - Phase → label mapping:
    - `scanning` → "Scanning folder for images…"
    - `hashing` → "Hashing and staging for exact duplicate detection…"
    - `copying` → "Committing a new frame…"
    - `duplicate` → "Duplicate found; skipping…"
    - `error` → "An item failed; continuing…"
    - `persistence` → "Committing the SQLite frame catalog…"
    - Unknown phases fall back to the phase name with underscores replaced
      and capitalized.
  - Bar text includes a running counters line `" · added <n>, duplicates <n>,
    errors <n>"` when any of the counters is non-zero.
  - `.complete(result)` sets the container state to `complete`,
    `expanded=False`, and shows a final message with the totals.

- **Maintenance expander**:
  - "Rebuild frame catalog from disk" button: calls `ingest.rebuild_index`,
    then shows `st.success(f"Rebuilt catalog: {len(idx)} unique image(s)
    tracked.")`.
  - Divider.
  - Text input "Create a new camera (folder name)" + button `Create camera`:
    sanitizes the name via `re.sub(r"[^A-Za-z0-9._-]+", "-", …).strip("-")`,
    calls `datamodel.ensure_camera_dirs(name)`, shows a success message, then
    `st.rerun()`. Empty/all-invalid input: `st.warning("Enter a valid camera
    name.")`.

### Deep ingest behavior (from `scripts/ingest.py`)
- SHA-256 duplicate detection on **file content**, not filename. Duplicates
  can be either already-in-catalog (`SELECT 1 FROM frames WHERE camera=? AND
  hash=?`) or repeat-within-batch (a hash first seen inside the same run
  ends up as a normal add, so intra-batch dedupe is DB-round-trip based; the
  first copy commits and the second sees it via the SQLite row and is
  skipped — provided the periodic flush has happened).
- Files are hashed and staged into `dest_dir` as `.ingest-*.tmp` via
  `tempfile.NamedTemporaryFile`. On duplicate, the temp file is unlinked
  in the `finally` block. On success it is `.replace()`-moved to the final
  path.
- Destination filenames are sanitized by `_sanitize`: strips any directory
  part, replaces every run of non-`[A-Za-z0-9._-]` with `_`, coerces the
  suffix to a known image extension (or `.png` fallback). `_unique_path`
  suffixes `_1`, `_2`, … if a collision remains.
- Empty files (`staged_bytes == 0`) become `errors` (`"<name>: empty file"`).
- The frame catalog is committed to SQLite every `INDEX_FLUSH_EVERY = 25`
  successful adds; a final commit runs after the loop. Failure of that
  final commit is reported but earlier flushed rows survive.
- After a successful ingest with any adds, `datamodel.invalidate_frames`
  invalidates the render-scope caches so the next read sees the new files.
- `IngestResult` carries `added` (destination filenames), `skipped`
  (original names), `errors` (`"<name>: <reason>"`). The Ingest report
  displays `n_added`, the list of `skipped`, and each error.

### Inputs / outputs
- Input: uploaded `UploadedFile` objects, or a folder path string.
- Output: files copied into `cameras/<camera>/unsorted/`; SQLite rows in
  `frames`; a session-state report block shown once.

### Observed, not confirmed with user
- `_TARGETS` in `ingest.py` is a dict of one entry (`"unsorted"`). Code paths
  in `_ingest_section` pass a `target` variable through but only one value is
  ever wired up; the `target` machinery is vestigial and the "Reference frames
  are no longer a separate folder" comment confirms it.
- The tuple `_INGEST_TARGET = ("unsorted", "frames")` is a module-level constant
  with only one entry; a loop was probably intended once.
- `ingest.ingest_folder` does not recurse. Users pasting a top-level folder
  containing subfolders of images will see zero files scanned; the caption
  ("Folder imports are non-recursive.") appears in the README, not in the
  view itself.
- The `re.sub` character class used for camera-name sanitization is
  `[^A-Za-z0-9._-]+` — leading/trailing dots survive if the user types
  `..cam..`, then get partially trimmed to `cam` (since only `-` is stripped).
  The result "cam" is valid but not obviously what the user typed.

---

## 3. ROI editor view (`scripts/view_roi_editor/`)

### User-visible purpose
Draw new ROI rectangles or move/resize existing ones on any ingested frame;
save them as named features scoped to the whole camera, a product, or a
shared subset of products. Also configure product names and delete ROIs.

### Behavior in detail

#### Header, scope caption, frame picker
- Header: `ROI editor — <camera>` (with ` › <product>` appended when in a
  product scope).
- Early return with a warning if the camera has no frames.
- **Scope caption**:
  - In product scope: "Drawing ROIs for product **<product>** — they apply
    only to its frames." If there are shared camera-level ROIs that also
    cover this product, appends `"  🔗 Shared ROIs also covering it:
    **<names>** (edit those at camera level)."`.
  - In camera scope, when a classification ROI exists: "Camera level. The
    product-sorting ROI is **<name>**; pick a product in the sidebar to draw
    that product's own inspection ROIs."
  - Neither caption appears when the camera has no classification ROI and
    no product is selected.
- **Frame picker**:
  - In product scope, the list is `frames_of_product(camera, product)`. If
    the product has no classified frames yet, it silently falls back to the
    entire inbox (`showing_all=True`), and a caption is shown explaining that
    "no frames are classified as X yet, so all N frames are offered".
  - Otherwise, in product scope: "Showing the **<n>** frames classified as
    **<product>**".
  - **Pin as reference** button (`📌`): stores the selected frame in the
    `settings` table under key `reference_frame` for the camera; on rerun, the
    selectbox opens on that frame. The pin caption always shows the current
    pinned filename, with `"⚠️ no longer present — pick another and pin it"`
    appended if the file is not in the current list.

#### Mode picker
- Rendered only if the current scope has any ROIs.
- Horizontal radio: `➕ Draw a new ROI` / `✥ Move & resize an existing ROI`.
- In move/resize mode: a second selectbox picks one of the scope's ROIs by
  its short name; the selected ROI becomes `edit_target`.

#### Background rendering (`_canvas.golden_with_rois`)
- Loads the frame via `curation.load_image` (BGR uint8), converts to PIL,
  resizes to `display_width` (from `ui_common.editor_display_width` — see
  section 8), and draws each existing ROI as a green rectangle with the
  feature's name in the top-left corner. In edit mode the target ROI is
  skipped from the baked background so it doesn't show twice.

#### Draw-new mode (`_draw.render_draw_new`)
- Caption: "Existing ROIs are drawn in green. Draw a new rectangle below,
  name it, and add it."
- If `streamlit-drawable-canvas` imports cleanly (`HAS_CANVAS`):
  - Renders `st_canvas` in `drawing_mode="rect"` with the background image,
    orange fill (`rgba(255, 165, 0, 0.2)`), red stroke (`#ff3030`), width 2,
    `update_streamlit=True`, and a key scoped by camera + frame.
  - Reads the **last** rectangle from `canvas.json_data["objects"]` and
    converts it to normalized `(x, y, w, h)` via `ui_common.box_from_object`,
    which correctly accounts for the canvas' `scaleX`/`scaleY` transform.
  - If the canvas raises at any point, catches, warns, and falls through to
    the manual box entry.
- Manual fallback: `st.image(bg)` plus four `number_input`s for x, y, w, h
  (defaults 0.25/0.25/0.5/0.5, step 0.01).
- Form ("add_roi", not `clear_on_submit`):
  - `Feature name for this ROI` text input.
  - If in camera scope AND no classify ROI exists yet, offers a checkbox
    `"Make this the **product-sorting** ROI (stage 1)"` plus a text input
    `"Product names (comma-separated)"`.
  - If in camera scope AND at least one product exists AND the ROI is not
    being made a classifier, offers `"Applies to products (leave empty = all
    products)"` multiselect. In-product scope this control is not shown;
    a product-scoped ROI is implicitly owned by that product.
- Submit validations:
  - Empty name → `st.error("Please enter a feature name.")`.
  - Missing rectangle → `st.error("Draw a rectangle first.")`.
  - Name containing `::` (the feature-scope separator) → `st.error` explaining
    it is reserved.
  - Classifier without ≥ 2 product names → `st.error`.
- On success: builds an `ROI` (with `role="classify"` and `classes=…` when
  applicable, or `products=…` when a shared quality ROI), replaces any
  existing ROI of the same full name, calls `datamodel.save_rois(camera, …)`,
  shows a success message and `st.rerun()`.

#### Move/resize mode (`_edit.render_edit`)
- Uses `st_canvas` in `drawing_mode="transform"`, seeded with the target
  ROI's stored geometry via `ui_common.fabric_rect`. The canvas key
  intentionally does **not** include the current live box, so drags don't
  cause the widget to be rebuilt mid-drag.
- Caption: "Drag the box to move it, or pull a corner/edge handle to resize.
  Other ROIs stay drawn in green for reference."
- Reads back the first rectangle in `canvas.json_data["objects"]` on each
  rerun and converts it via `ui_common.box_from_object`.
- Four `number_input`s (step 0.002, format `%.4f`) reflect the current box.
  Their keys include a `nonce` derived from the box tuple, so a canvas-driven
  change reseeds them; typing keeps the value until the box changes again.
- If the box was moved AND the feature already has any labels/goldens,
  shows an amber warning telling the user to re-run Refresh scores.
- `💾 Save position` button is disabled until the box actually changed.
  On click, updates the ROI in memory, `datamodel.save_rois(camera, all_rois)`,
  success message, `st.rerun()`.
- A caption below shows the saved coordinates and `"  ·  unsaved changes"`
  or `"  ·  unchanged"`.

#### Products editor (`_roi_list.render_products_editor`)
- Rendered only in camera scope AND when a classify ROI exists.
- Expander titled `"Products — classes of '<classify_feat>'"`.
- Text input pre-filled with the current class list joined by `", "`.
- Save button parses the input, requires ≥ 2 products, otherwise
  `st.error("Keep at least two products.")`. On success, rewrites the
  classify ROI's `classes` in `rois.json`.

#### Defined ROIs card list (`_roi_list.render_defined_rois`)
- Subheader `"Defined ROIs"` + explanatory caption.
- If a classification ROI exists and some frames are still unassigned to any
  product, shows an info banner explaining the discrepancy between per-ROI
  frame counts and the camera total. (Only appears when `all_products` is
  non-empty and `unclassified > 0`.)
- One bordered container per ROI in the current scope, containing:
  - Headline HTML (`_headline.roi_headline`): 56×56 rounded-corner thumbnail
    (data URI) + name + colored scope chip + a metadata line
    `"<seen> of <total> frames · <n> golden(s) · <n> labeled · <active or 'no version yet'>"`
    (frame count reads `"<seen> of <total>"` only when the ROI sees a subset).
    Scope chip colors: brown "🗂 product sorter", blue "🔗 shared · …", green
    "<owner> only", or a neutral pill "all frames".
  - Trash `🗑` tertiary button: sets the delete-confirm flag in session state
    (`ui_common.confirm_delete_key`).
  - For camera-level quality ROIs (not classify, and there are products
    available): a multiselect "Applies to products". Save-on-change:
    `_save_products` callback writes the selection immediately and shows a
    toast reminding to Refresh scores.
- If the delete-confirm flag is set, appends `_render_delete_confirm` below
  the card:
  - Amber warning listing the counts that would be removed (labels,
    goldens, versions).
  - `✅ Yes, delete`: `datamodel.delete_roi` (drops the ROI from
    `rois.json`), `labels.purge_feature` (deletes labels, goldens, score
    cache, results cache, dedup mutes, scatter cache, cluster snapshot,
    grid/dedup settings, versions), also pops the scored-list session state
    for that feature and `ui_common.clear_ranked` (best-effort — see
    `STRUCTURAL_AUDIT.md` §Dead code), then success + rerun.
  - `Cancel`: clears the flag and reruns.

### Inputs / outputs
- Input: rectangle geometry from the canvas or numeric fields; text (name /
  products); the pinned reference frame filename.
- Output: `cameras/<camera>/rois.json` overwritten atomically each save;
  `settings.reference_frame`; and (on delete) large purge across labels,
  goldens, versions and derived caches.

### Observed, not confirmed with user
- `docs/current-project.md` lists "The ROI canvas does not reliably occupy
  the intended browser width on every display" as a known limitation; the
  view relies on `streamlit_js_eval` to read `window.innerWidth` and falls
  back to `DEFAULT_DISPLAY_WIDTH = 900` when JS eval is missing or returns
  falsy. The `-380` sidebar/padding subtraction is a fixed magic number
  independent of Streamlit's actual chrome, which likely explains the
  reported width issue.
- The move/resize mode radio only appears when the current scope already has
  ROIs. That means: in a product scope with 0 product-owned ROIs but with
  shared ROIs covering the product, there is no way to edit those shared
  ROIs from inside the product scope. (Consistent with the caption "edit
  those at camera level".)
- The manual-box fallback in draw mode always resets to (0.25, 0.25, 0.5,
  0.5) each rerun; typed values are lost unless the form is submitted.
- The image-to-URL shim in `_canvas.py` monkey-patches
  `streamlit.elements.image.image_to_url` if it is missing. It runs at
  import time and does not check whether the caller signature matches
  future Streamlit versions.

---

## 4. Dedup view (`scripts/view_dedup.py`)

### User-visible purpose
Cluster near-duplicate frames per feature using DBSCAN on ResNet embeddings,
so the user can pick one representative per cluster and mute the rest from
the Classify view.

### Behavior in detail
- Header: `Dedup — <camera>` (with ` › <product>` when set).
- **Availability gates**:
  - If `embedding.backbones()` is empty (torch not installed or no configured
    backbones): warns and returns.
  - If `sklearn.cluster.DBSCAN` fails to import: warns and returns.
- **Feature picker**: `datamodel.list_features_for(camera, product)` plus
  a synthetic `compose_feature(product, "whole-frame")` entry, formatted by
  `ui_common.feature_label` (which appends `"🔗 shared"` for a shared ROI
  seen inside a product scope).
- If the feature has zero frames in scope: info message and return.
- Caption: `"**<n> frame(s)** in scope. DBSCAN groups near-identical cutouts…"`
- **Controls** (`_controls`):
  - Loads persisted settings from `db.settings` (keys
    `dedup.method.<feature>`, `.epsilon.`, `.min_points.`) with defaults
    `resnet50` / `0.02` / `2`, coerced through `str/float/int`.
  - If the saved backbone isn't currently available, falls back to
    `dedup.DEFAULT_BACKBONE` (or the first available one).
  - Three columns: Embedding selectbox (all backbones), Epsilon slider
    (0.001–0.20, 0.001 step, `%.3f` format), Min points slider (2–10, step 1).
  - Widget keys carry a `"::g<generation>"` suffix so the Revert button (see
    below) can force a re-init cleanly.
  - Persists any changed setting back to SQLite (skipping writes when the
    value hasn't changed since the last write in this session, tracked by a
    `dedup::persisted::…` marker).
- **Cluster action** (`_cluster_action`):
  - Shows `🔍 Cluster` (primary) and `↺ Revert sliders` buttons plus a caption
    with the current neural device.
  - Cluster: runs `dedup.cluster` with a progress bar
    `"Embedding {d}/{t}"`. Stores the `ClusterResult` in session state
    (`dedup::result::<camera>::<feature>`) and clears any custom
    representative picks.
  - Revert sliders: disabled when there is no cached result or the sliders
    haven't drifted. On click, writes the cached result's slider values
    back to SQLite, clears the "already persisted" markers, bumps the
    widget generation, and reruns.
  - If a cached result exists and the sliders have drifted, shows an amber
    "Sliders changed since the last cluster" warning listing the drift
    (`embedding r1 → r2`, `ε 0.010 → 0.015`, etc.).
- **Summary metrics** (four columns): Clusters count, Covered frames,
  Unique (noise), Would mute (default rep pick).
- **2D scatter expander** (`_render_scatter`), collapsed by default:
  - Silently omitted if Plotly is not installed or fewer than 2 embeddings.
  - Radio "Projection" (horizontal): UMAP / t-SNE.
  - Calls `scatter.project` which caches results per
    (camera, feature, method, backbone) with a `frames_sig` invalidation
    key. If `umap` or `sklearn.manifold.TSNE` isn't importable, captions a
    helpful install hint and returns.
  - Assembles the Plotly figure with:
    - Grey small markers for noise/unique frames.
    - One trace per real cluster, colored by cluster ID via the same
      categorical palette used for classes.
    - A ring overlay for representatives (black outline, no fill).
    - Diamond markers for goldens, colored by class.
  - Caption reminds the user this is a sanity-check surface and marks the
    projection as `(from cache)` or `(freshly projected)`.
- **Clusters list** (`_render_clusters`):
  - For each real cluster (largest first, then id): an expander titled
    `"Cluster <cid> — <n> frames · rep: <frame>"`, first cluster expanded
    by default.
  - Inside each expander: up to 24 thumbnail cutouts (via
    `ui_common.cutout_thumb`), then a horizontal radio "Keep as
    representative" over every member. The radio label is collapsed.
    Overflow caption: `"…and <n> more members not shown."`.
  - Below the real clusters, a collapsed expander for noise frames shows
    up to 20 thumbs and reports the overflow count.
- **Apply panel** (`_apply_panel`):
  - Button `🔇 Apply — mute <n> frame(s)` (primary; disabled when
    `would_mute == 0`).
  - On click: `dedup.apply` inserts new mutes and clears stale ones. The
    success message reports `"Muted N frame(s)"` plus `", unmuted M …"` if
    any and, if any labeled/golden/rep frames were skipped, a `" ·
    skipped: N labeled, M golden"` tail. Also clears the cached result +
    picks so a re-cluster is required for the next apply.
  - `dedup.apply` writes a per-frame snapshot (`cluster_snapshot`) that the
    Classify grid reads to annotate cards with a small "cluster N" chip.
- **Existing mutes panel** (`_existing_mutes_panel`):
  - Rendered at the end of the view (even in the pre-cluster branch) if any
    mutes exist for this feature.
  - Two-step confirmation: first click sets a `dedup::clear-confirm::…`
    session flag, second click (`Yes — unmute all`) calls
    `db.clear_dedup_mutes`; `Cancel` clears the flag.

### Deep dedup behavior (from `scripts/dedup.py`)
- Embeddings pipeline is shared with Classify (`classify.fetch_vectors`
  with `include_classical=False`). Frames whose image cannot be loaded are
  silently dropped from `kept`.
- Cluster ordering: real cluster IDs sorted by member count desc, then id
  asc; each cluster's default representative is the frame whose (unit-norm)
  embedding is closest to the L2-normalized cluster centroid.
- `apply` never mutes a labeled or golden frame (checks against
  `labels.current_labels` and `labels.current_goldens`); those frames stay
  visible in Classify by design. It also unmutes any previously-muted
  frame that would no longer be muted under the current clustering.
- `load_snapshot` returns `{frame: (cluster_id, is_rep)}` — `-1` means
  noise. A missing frame in that map means it wasn't part of the
  clustering (e.g., ingested after apply).

### Inputs / outputs
- Input: sliders + feature; button clicks.
- Output: mute rows in `dedup_mute`; a `cluster_snapshot` blob for the
  Classify view; per-feature persisted slider defaults; cached scatter
  projections.

### Observed, not confirmed with user
- The scatter expander's `use_container_width` is passed to
  `st.plotly_chart`, which is fine for now but Streamlit has deprecated
  that argument in favor of `width`.
- If clustering succeeds but the scatter fails to project (e.g., UMAP
  errors), the warning replaces the whole scatter for the run but the
  cluster list and apply flow remain fully functional.
- `dedup.apply` clears the result + picks in session state on success, so
  the user is forced to re-cluster before applying again. The button and
  the mute list panel below share the view, so after applying, the mute
  list at the bottom is what confirms the change.

---

## 5. Classify view (`scripts/view_classify/`)

### User-visible purpose
The largest view. Pick a feature, refresh scores against golden references,
review a paginated grid of frames, and label / mark-golden per frame or in
bulk.

### Behavior in detail

#### Header + one-off CSS
- Header: `Classify — <camera>` (with ` › <product>`).
- Injects `OK_TINT_JS` (in `_styles.py`) via `st.html(unsafe_allow_javascript=True)`.
  The script:
  - Adds a `<style>` block to the parent document (Streamlit iframe wrap-around)
    that tints buttons carrying class `classify-ok-active` green (`#1a7f37`).
  - Walks every `<button>` and toggles that class on any button whose `kind`
    attribute is `"primary"` AND whose visible text is exactly `"OK"`.
  - Installs a `MutationObserver` (once) so page turns and other DOM churn
    re-paint the class.

#### Feature picker (`_pick_feature`)
- Selectbox over features in the current scope plus `whole-frame` entry.
- If the feature is a shared ROI: caption "🔗 Shared ROI — one golden set and
  one label set covering **<products>**. The grid shows every frame of those
  products, whichever one the sidebar is on." Appends a gap explanation when
  some frames are still unclassified: "It covers **N of M** frames — the
  other N-M have no product yet, so sort them under *All frames — product
  sort* first."
- If in product scope and this feature has zero frames yet: info banner
  telling the user to sort frames first.

#### Metrics + start hint
- `_metrics`: Frames total + one metric per class, with the corresponding
  golden count as a subtle `delta` (`delta_color="off"`).
- `_start_here`: cold-start info banner when no class has any goldens yet,
  suggesting the user star a few reference frames.

#### Refresh scores + persistent cache (`_refresh`)
- **Cache hydration**: first time this feature is seen in the session, tries
  `db.load_results` to populate `st.session_state[scored_key]`,
  `+"::gsig"`, `+"::fsig"`. Malformed rows are ignored (bare `except`
  around `deserialise_results`).
- Two columns:
  - `🔄 Refresh scores` (primary): on click, calls `classify.refresh` with a
    `ScoringProgressUI`. On success:
    - Persists results to the SQLite `results_cache` (`golden_sig`,
      `frames_sig`, JSON payload).
    - Updates session state (`gsig`, `fsig`).
    - If the persistent write fails: shows a warning via
      `ScoringProgressUI.warning`, session state still holds the results.
    - Progress phases: `discovery` → `features` (per-frame preparation) →
      `comparison` → `persistence` → `presentation`.
  - Caption: `Methods: <list> · neural device: <cpu|cuda> · cached — only the
    first pass over a new batch is slow.`
- If nothing is cached in session state after both steps:
  - No `unsorted/` frames: `st.warning`, and return.
  - Frames exist but not scored yet: caption "Click **Refresh scores** to
    evaluate the inbox." and return.

#### Stale-warning banners (`_stale_warning`)
- If the golden signature drifts from the cached one: amber banner
  "⭐ Goldens changed since the last refresh — mark as many as you like,
  then hit Refresh scores…".
- Else, if only the frame signature drifted: amber banner
  "🆕 The frame set changed since the last refresh (ingest or delete)…".

#### Dedup mute filter (`_apply_mute_filter`)
- If there are muted frames for the feature, a `Show muted (<n> hidden by
  dedup)` checkbox appears (default false). When unchecked, muted frames
  are filtered out of the results in memory (no re-refresh).

#### Filter/sort controls (`_controls.render_controls`)
- Three columns:
  - Show: `All`, `Unlabeled`, `Labeled <cls>` for each class, `Golden`,
    `Methods disagree`, `Deleted`.
  - Rank using: available methods (`cpu`, `resnet18`, `resnet50` when
    installed). Default = `resnet50` if present, else first. Disabled
    while unscored.
  - Order by: `Most novel first`, `Most uncertain first`, `Name`.
    Disabled while unscored.
- Below the row, one of two long captions:
  - Unscored: explanation with "Mark at least one ☆OK, then press Refresh
    scores".
  - Scored: bar-length explanation. If < 2 classes have goldens, second
    caption explains why the leaning badges show "–" and suggests marking
    another class.

#### Filter + sort logic (`_controls.filter_and_sort`)
- `Deleted` view: only frames in `db.deleted_frames_of(camera)`.
- Everything else excludes deleted frames.
- `Unlabeled`: frame not in labels dict AND not in any golden class.
- `Labeled <cls>`: `lab.get(frame) == cls`.
- `Golden`: `golden_class_of(gold, frame)` is truthy.
- `Methods disagree`: leaning set (excluding None) has > 1 element.
- Sorts:
  - `Most novel first`: `(no score, -novelty)` — frames without a score
    for the ranking method go last, then descending by novelty.
  - `Most uncertain first`: `(no score / no margin, margin asc)`.
  - `Name`: filename ascending.
- If unscored, ordering is always by filename.

#### Bulk-label expander (`_bulk.render_bulk`)
- Only appears if `scored` and there is at least one candidate that has a
  score under the ranking method (goldens are excluded because they carry
  no `per_method`).
- Expander title includes the count of selectable candidates.
- Radio "Select" with three modes:
  - **Frames leaning a class**: class selectbox + minimum-margin slider
    (range = observed margin range, step = 1% of range or 1e-6). The
    caption calls out "you need goldens marked on both sides".
  - **Most ordinary**: uses `novelty`, slider "Select everything at or
    below".
  - **Most uncertain**: uses `margin`, slider "Select everything at or
    below".
- Caption "**N** of M matching frames selected — labelling applies to *all*
  of them, not just the page…".
- One `Label selection <cls>` button per class; disabled when nothing
  picked. On click, `labels.set_labels_bulk`, success message, rerun.

#### Auto-assign expander (`_auto.render_auto`)
- Only if `scored` AND at least one candidate has a leaning + margin under
  the ranking method + isn't already labeled/golden.
- Multiselect "Include only these classes" (defaulted to all classes).
- Margin slider (same range/step logic as `_bulk`).
- Preview "**N** frame(s) will be labelled:" and a per-class breakdown line:
  `` `<cls>` — **N** frames · avg margin 0.1234 ``.
- Checkbox "Show these N in the grid below" (disabled when total is 0).
  When checked, the outer render narrows the grid to exactly those frames
  (Show/class filters ignored while the preview is on) and shows a caption
  saying so.
- `✅ Confirm auto-assignment of N frame(s)` button (primary, disabled at
  zero): calls `labels.set_labels_bulk` per class with `source="auto"`, then
  success + rerun.

#### Suggested goldens expander (`_suggest_goldens.render_suggest`)
- Only if `scored` AND ≥ 2 classes have goldens AND at least one unlabeled
  candidate exists.
- Slider "How many picks" (3–20, default 10).
- Picks are chosen by `suggest(...)`:
  - Filter to unlabeled non-golden candidates with a leaning + margin under
    the ranking method.
  - Sort ascending by margin (most uncertain first).
  - Take the top 100 as a pool.
  - If ResNet is available: fetch embeddings for the pool, seed picks with
    the shakiest, and greedily add the frame in the pool that maximizes
    minimum cosine distance to already-picked frames (farthest-point
    sampling). Fallback: top-N by margin when no ResNet is available.
- Caption reports the backbone used for diversity (or its absence).
- Grid: 3 columns per row; each card shows the ROI thumbnail, per-class bars,
  filename, and one "⭐ <cls>" button per class. Clicking a button writes
  both a label AND a golden with `source="suggest"`, shows a toast
  `"Promoted <frame> → ⭐ <cls>"`, and reruns.

#### Grid (`_grid.render_grid`)
- Per-feature persisted settings: `grid.perpage.<feature>` and
  `grid.cols.<feature>` in `settings`. Options: per page in {12, 24, 48, 96},
  cols in {3, 4, 5, 6, 8}. Defaults: 24 per page, 4 cols.
- Two control rows (top + bottom of grid) share one source of truth per
  setting via a pre-render mirror; both bars display and drive the same
  value. Each control row:
  - `« First`, `‹ Prev`, centered "Page X of Y  ·  frames S–E of N", `Next ›`,
    `Last »`. Boundary buttons are disabled at page 1 / last page.
  - Per page / Columns selectboxes with `label_visibility="collapsed"` and
    small right-aligned labels beside them. Changes fire the `_sync_setting`
    callback which persists to SQLite (only when the value actually changed
    from the last saved).
- If per page ≥ 48: a caption warns that initial thumbnail preparation and
  browser rendering take longer, recommending 24.
- A "Preparing N grid cards and thumbnails…" caption is shown just before
  rendering the grid (cleared right after). *Note: the ellipsis in the code
  is written as the mojibake `â€¦` — see observed items below.*
- Iterates the current page in `n_cols`-wide rows, each cell a bordered
  `st.container`.
- Each card (`_card`, wrapped as `@st.fragment` so a click only reruns that
  card):
  - Thumbnail: `ui_common.cutout_thumb(path, roi_tuple, mtime)`. On
    exception, `st.error("thumb error: …")`.
  - Reads the frame's current label / golden / deleted state via
    `_card_state`: uses bulk snapshots on full renders, targeted point
    queries on fragment reruns.
  - If the frame is golden: colored chip `⭐ <class>` + " reference — not
    scored".
  - Else if scored: leaning badges + per-class bars for the ranking method.
  - Caption `{fs.frame[:22]}  \n<tag>` where tag is `⭐**cls**`, `**cls**`, or
    `—`.
  - If a `cluster_snapshot` covers this frame: a small color-coded chip
    "cluster N" or "cluster N · rep" or "unique".
- Button row (`_buttons`):
  - Column layout: [class buttons] + `★` + `🗑`. For 2-class features the
    star is placed between the two class buttons (`[OK] [★] [NG]`);
    otherwise the star sits after all class buttons.
  - Class button: primary when the frame is currently labeled that class,
    secondary otherwise. Clicking a labeled class again clears the label
    (and drops the golden if it matched). Clicking a different class writes
    the new label and (if a golden already existed) atomically moves the
    golden to the new class. Ends with `st.rerun()` (fragment-scope by
    default).
  - Star `⭐/☆`: disabled until the frame is labeled. Clicking toggles
    golden on/off for the current label. Ends with `st.rerun()`.
  - Trash `🗑/↺` tertiary button:
    - Delete: clears any golden and any label for the current feature, then
      calls `db.mark_frames_deleted` for the whole camera, then
      `st.rerun(scope="app")` so the deleted frame actually leaves the
      current view and top metrics update.
    - Restore: `db.restore_frames`.

### Inputs / outputs
- Input: refresh clicks, filter/sort controls, label/star/trash clicks,
  bulk & auto expanders, suggested-goldens slider/buttons.
- Output: rows in `labels` and `goldens`; `deleted_frames` rows;
  `results_cache` payload; `settings` rows for per-feature grid config.

### Observed, not confirmed with user
- The "Preparing … grid cards and thumbnails…" caption contains the raw
  mojibake bytes `â€¦` where an ellipsis (`…`) was intended
  (`view_classify/_grid.py:106`). Users see it as garbage characters.
- `@st.fragment` scope on `_card` means the top metrics (Frames, per-class,
  golden counts) do NOT update when the user labels or stars from inside the
  grid; they only refresh on a full-page rerun (pagination, filter change,
  refresh, delete/restore). The docstring calls this out as an intentional
  trade-off.
- The Show filter's "Deleted" branch shows soft-deleted frames but the row
  buttons still allow labeling and starring; nothing prevents a user from
  labeling a deleted frame while browsing the Deleted view. (The `Delete`
  branch itself cascades-clear labels+golden on delete, so a fresh delete
  is clean; but re-labeling a deleted frame from the Deleted view would
  reintroduce label state without restoring the frame.)
- If the persistent `results_cache` row is present but the golden or frame
  signature has drifted since it was written, hydration still shows the
  cached grid on entry (and the stale warning appears). This is the
  documented behavior; worth surfacing as a design choice not to
  auto-refresh.

---

## 6. Insights view (`scripts/view_insights.py`)

### User-visible purpose
Per-method confusion matrix (label vs. leaning) over the currently-labeled
non-golden frames, plus an accuracy percentage.

### Behavior in detail
- Header: `Insights — <camera>` (with ` › <product>`).
- Feature picker: same set as Classify's (features in scope + whole-frame).
- Loads current classes, goldens, labels, and available methods.
- Held-out set: every labeled frame that is not a golden.
- Preflight gates:
  - If < 2 classes have goldens: info banner explaining why a matrix isn't
    possible, listing the classes that already have references. Returns.
  - If no held-out frames: info banner "every label is currently a ⭐golden".
    Returns.
- Two-column button row: `🔄 Compute matrices` (primary) + long caption
  `"Rows = your label · columns = method's leaning · N held-out frames · ⭐
  goldens excluded."`.
- On click: runs `classify.refresh` with a `ScoringProgressUI` (title
  "Computing insight matrices…"); on failure `progress.error("Matrix scoring
  failed")` and reraise. Result stored in
  `st.session_state[f"insights::<camera>::<feature>"]`. Then advances the
  progress to `presentation`.
- If nothing is cached in session state yet: caption "Click **Compute
  matrices** to score frames and render the matrices." and return.
- For each method: one Streamlit column with:
  - `**<method>**` header.
  - Matrix HTML (`_render_matrix`): a small `<table>` with green cells for
    diagonal hits, pink for off-diagonal, transparent for zeros. Rendered
    via `st.markdown(..., unsafe_allow_html=True)`.
  - `_build_matrix` counts each held-out frame's `(true, pred)` pair
    (`pred = per_method[method].leaning`); frames whose method has no
    leaning are counted as `skipped`.
  - Caption `Accuracy **X.X%** (correct/total)` and, if any skipped, `· N
    unscored`.
- After rendering all methods, `progress.complete("Insight matrices ready")`
  when a fresh compute happened.

### Inputs / outputs
- Input: feature selection + button click.
- Output: read-only display; session-state cache of scored results.

### Observed, not confirmed with user
- The Insights view runs `classify.refresh` under a different session-state
  key (`insights::…`) than Classify (`classify::…`), so the two views don't
  share their scored result. Every visit to Insights that starts fresh
  requires clicking Compute matrices again.
- If a class name exists in `evaluable` (from labels) but not in `classes`
  (from `datamodel.classes_for`), the row is silently dropped from the
  matrix (`if true_c in class_set and pred_c in class_set`). The Accuracy
  denominator only counts kept pairs. This can hide previously-labeled
  frames whose class was later removed from the ROI's class list.

---

## 7. Versions view (`scripts/view_versions.py`)

### User-visible purpose
Freeze the current label + golden state of a feature as a numbered snapshot,
show history, and revert or export any snapshot.

### Behavior in detail
- Header: `Versions — <camera>` (with ` › <product>`).
- Feature picker (same shape as Classify/Insights).
- Working-state caption: per-class current + golden counts + unlabeled/total.
- **Freeze form** (`freeze_version`, `clear_on_submit=True`):
  - Text input `Version name` (placeholder "e.g. first-clean-batch").
  - Text area `Notes (optional)`.
  - `🔒 Freeze version` (primary).
  - On submit: retrieves the scored list from
    `st.session_state["classify::<camera>::<feature>"]` if present and
    passes `classify.stats_for(scored)` as `stats`; empty stats otherwise.
    Calls `versions.freeze`, shows success `"Froze **v<n>** — ..."` with
    per-class counts, `st.rerun()`.
  - `freeze` uses the max existing number + 1, sets the new version's
    `active=1`, all others `active=0`. Snapshot items include both labels
    and goldens (kind = "label" | "golden"), each with the frame's hash.
    A frame that is both labeled and golden for the same class produces two
    rows and will be exported once (dedup at export time).
- If no versions exist yet for this feature: info banner and return.

- **History dataframe** (`st.dataframe`, `width="stretch"`, `hide_index=True`),
  most-recent first:
  - `""` column with "▶ active" for the active row.
  - `version`, `name`, `created` (formatted as `%Y-%m-%d %H:%M`).
  - Per-class label count columns and per-class ⭐count columns.
  - `unlabeled`, `change vs previous` (from `versions._delta_line`, which
    formats non-zero deltas for every non-total/non-unlabeled key).

- **Actions**: one collapsible expander per version (reversed).
  - Header text: `v<N> — <name>  ·  ▶ ACTIVE  ·  <timestamp>`.
  - Notes caption (if any).
  - `Change vs previous: …`.
  - If stats present: a per-method stats dataframe (mean/median/min/max).
  - Actions row: `⏪ Revert to this` (disabled when this version is
    already active), `📦 Export`, plus a spacer column.
  - Revert: sets a `confirm_revert::<vid>` flag → shows an amber warning
    ("Revert the working state to **v<N>**? …") with `✅ Yes, revert` and
    `Cancel` buttons. Yes: `versions_mod.revert` (which reconciles labels
    and goldens frame-by-frame and moves the `active` flag). Also pops
    `classify::<camera>::<feature>` from session state so the Classify view
    will re-hydrate from cache next time. Success and rerun.
  - Export: shows an `st.spinner("Exporting cutouts…")` around
    `versions_mod.export`, then a success message with the total written
    and the destination path. If any missing frames: amber warning listing
    up to 5. If any hash mismatches: red error listing up to 5.

### Deep versions behavior (from `scripts/versions.py`)
- `freeze` writes to `versions` and `version_items` in one transaction,
  computes counts and includes them as JSON. Stats are passed in by the
  caller and stored verbatim.
- `revert` compares snapshot labels and goldens with current state and
  issues per-frame `set_label`, `clear_label`, `mark_golden`,
  `unmark_golden`. It then flips `active` on the versions table. Because
  each per-frame call is its own transaction, a mid-revert failure would
  leave the working state partially reverted.
- `export`:
  - Destination: `cameras/<camera>/exports/<feature-safe>/v<NNN>__<name-safe>/<cls>/`.
  - `<feature-safe>` = the feature name with `"::"` replaced by `"-"`
    (Windows-safe).
  - `<name-safe>` = characters that are alphanumeric or `-`/`_`; every
    other character is turned into `-`.
  - Each `(frame, class)` pair is deduplicated (`seen: set[tuple[str, str]]`).
  - For each item: verifies the source exists; if the stored hash differs
    from the current file's hash (via `labels.frame_hash`, which populates
    the hash on first access), records `hash_mismatch` and skips writing.
  - Loads the source via `engine.curation.load_image`, crops with the ROI,
    encodes as PNG via `cv2.imencode`, writes the bytes with
    `buf.tofile(str(...))`. Filename pattern:
    `{Path(frame).stem}__{safe_feature}.png`.

### Inputs / outputs
- Input: name/notes text, button clicks.
- Output: rows in `versions` and `version_items`; PNG files under
  `cameras/<camera>/exports/…`; on revert, updates to `labels` / `goldens`.

### Observed, not confirmed with user
- `versions.export` writes into `<safe_feature>/v<NNN>__<name>/…` but
  `docs/current-project.md` and the module docstring differ slightly on
  path shape; the code is authoritative here.
- `versions.revert` is not transactional across frames; a failure in the
  middle would leave a partially reverted working state. The
  `versions.active` flag also flips independently at the end, so an early
  failure could leave the labels partially updated but no version marked
  active.
- The Freeze form reads scored results from session state; if the user
  hasn't visited Classify (or if their session state has expired), stats
  come back empty and the version's `stats_json` is `{}` even though
  `results_cache` might hold a persistent copy. This is a soft loss of
  information, not a correctness bug.
- The dataframe assumes every class known today applies to every historical
  version; a version whose counts have a class not in the current
  `classes_for` list is not rendered as its own column (the frozen JSON
  still holds it, but the presentation loop iterates today's classes).

---

## 8. Cross-cutting UI behavior (from `scripts/ui_common.py`)

### Thumbnail rendering
- `cutout_thumb(frame_path, roi_tuple, mtime) -> bytes`: bounded LRU cache
  of 256 entries. Keyed by (file path, ROI tuple, `mtime`). Returns
  optimized JPEG bytes at quality 90. Cache misses record a perf counter;
  cache hits recorded by comparing the LRU's `hits` before/after the call.
- `thumb_data_uri(frame_path, roi_tuple, mtime, size=128) -> str`:
  128-entry cache. Returns `data:image/jpeg;base64,…`. Used by the ROI
  editor's card thumbnails (which need a base-64 URL rather than a Streamlit
  media file, to sidestep the drawable-canvas shim's registration order).
- `square_thumb`: returns a PIL image (not cached bytes) that is centre-
  cropped square then resized. Used indirectly via `_cached_thumb_data_uri`.
- `clear_thumbnail_caches()` exists for tests/benchmarks.

### Class colors + bars
- `class_color(cls, classes)`: OK is `#1a7f37`, NG is `#c62828`; otherwise
  picks from an 8-color categorical palette by index in the class list,
  falling back to `#6b7280`.
- `class_bars_html(dists, classes, close_call=0.90)`: per-frame per-method
  bars. Bar length is **relative closeness** (`min_dist / d`); the leader
  gets full opacity + weight 600; others are dimmed. Missing classes render
  a transparent placeholder. A tiny 2 % floor keeps sub-2 % bars visible.
  Footer under bars: `nov 0.xxx · margin 0.xxx`, prefixed with `⚠ close
  call ·` when the runner-up sits within 90 % of the leader's distance.

### Scoring progress UI
- `ScoringProgressUI`: `st.status` + `st.progress`. Phase-aware labels for
  `discovery / features / comparison / persistence / presentation`. Any other
  phase falls back to its titlecased name. `.complete(label=None)` uses
  either the given label or the pending warning, then sets state
  `complete` and `expanded=False`. `.warning(label)` stashes a message that
  will replace the default "Scores refreshed" text at completion.
  `.error(label)` puts the status into the error state and expands it.

### Viewport width
- `editor_display_width`: uses `streamlit_js_eval` to read
  `window.innerWidth`. On any failure or a falsy return, falls back to
  `DEFAULT_DISPLAY_WIDTH = 900`. Otherwise returns `max(480, min(inner - 380,
  MAX_DISPLAY_WIDTH))`. Only used by the ROI editor.

### Feature label
- `feature_label(camera, feature, product=None)`: returns the short name
  from `split_feature`, with `"  🔗 shared"` appended when a camera-level
  feature is being surfaced inside a product scope.

### ROI serialization helpers
- `roi_key(roi)`: a hashable tuple used as a cache key.
- `fabric_rect(roi, disp_w, disp_h)`: fabric.js rect dict for the canvas.
- `box_from_object(obj, disp_w, disp_h)`: inverse — respects the object's
  `scaleX`/`scaleY`, clamps to `[0,1]`.

---

## 9. Data-model invariants observed in code

These are enforced by the domain layer, not by any single view:

- Ingest cannot create two catalog rows with the same content hash within
  one camera (`UNIQUE (camera, hash)`).
- `labels.set_label(camera, feature, frame, "")` clears the label AND golden
  atomically.
- `labels.clear_label` deletes both `labels` and `goldens` rows for the
  frame + feature in a single transaction.
- `labels.set_label` (with a non-empty class) updates the goldens table so a
  golden's class always follows the label's class.
- `labels.mark_golden` upserts BOTH the label and the golden for the frame
  in one transaction (`source="golden"` on the label), so a starred frame is
  always labeled.
- `labels.purge_feature` deletes labels, goldens, `score_cache` for that
  feature (across cameras — cache is keyed by feature alone),
  `results_cache`, `dedup_mute`, `scatter_cache`, `cluster_snapshot`,
  selected `settings` rows (grid + dedup keys only), and versions +
  cascaded version items.
- `datamodel.compose_feature` / `split_feature` join by `"::"`; the
  draw-new form rejects names containing `"::"`.
- The classify ROI defines the camera's product list; every quality feature
  in a product scope is `<product>::<roi>`. A shared ROI (`role="quality"`
  with a non-null `products` list) covers the union of listed products.

## 10. Observed, not confirmed with user (cross-cutting)

- **Encoding artifact**: `scripts/view_classify/_grid.py:106` writes
  `"Preparing {len(shown)} grid cards and thumbnailsâ€¦"` — the ellipsis
  was double-encoded as `â€¦`. Users will see the raw bytes in the UI.
- **Torch import cache**: `embedding._ensure_torch` sets a module-level
  `_import_failed` flag once. If the user starts the app without torch,
  installs it, and then restarts Python, this is fine; but if they somehow
  make torch importable during the same process, the flag prevents
  detection. That is unusual enough to be a non-issue in practice.
- **Session-state key sharing**: the Freeze form in Versions reads
  `st.session_state["classify::<camera>::<feature>"]`. That key is defined
  in `_helpers.scored_key`. Changing that convention (say, adding a method
  suffix) would silently break stats-freeze.
- **`unsafe_allow_html=True` HTML injections**: appear in
  `ui_common.class_bars_html`, `_helpers.leaning_html`, `view_insights`,
  `view_status`-ish (dataframe strings are safe), and the ROI editor
  headline. Frame filenames are HTML-escaped in the headline
  (`html.escape`), and class names are escaped in `class_bars_html`. Method
  and cluster names in insights and the cluster chip are trusted strings
  built from ints/known method IDs. This is a safe pattern for the current
  data, but worth documenting because any future free-text field written
  into these blobs would need explicit escaping.
- **Streamlit fragment scope on the grid card** means the sidebar / top
  metrics do not update between label clicks. This is deliberate and
  documented in the docstring; noting it here so any refactor preserves
  the trade-off.
- **Auto-assign preview**: enabling the "Show these N in the grid below"
  checkbox narrows the grid to those frames but also visibly reduces the
  top metrics' relevance for the moment — those metrics were computed from
  the raw counts, not the current visible set. This matches the current UI.
