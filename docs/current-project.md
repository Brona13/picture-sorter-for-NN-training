---
name: current-project
description: Authoritative snapshot of the current purpose, architecture, capabilities, limitations, and open work
status: current
document_type: project-status
last_updated: 2026-10-20
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

The **Chain** page (v1.51.0) draws this per camera as boxes and arrows: Ingest → ROI product → Classify → ROI feature → Classify. It is a view of the ROI definitions, not a second source of truth.

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

- **Measurement chain on the Overview (v1.76.0):** a camera that has Crop / Detector / Calculate / Evaluation boxes shows them in its Overview card as a row of small cards in chain order (kind, name, the same one-line status as on the Chain, `chain.describeFlow`; a click opens the box's page, `onOpenFlow`), and the boxes the detectors found on the reference picture are drawn over it (turned as found, one colour per box, placed on the whole picture by adding the crop offset). Backend: `chain.overview_flow` in `GET /api/overview` as `flow` (`null` without boxes; `nodes`, `boxes`, `size`); only the reference frame's stored boxes are read.
- **Faster Overview (v1.75.3):** `GET /api/overview` read the database through about 2,000 short-lived connections for 20 cameras (a file open and a pragma each, 8,600 queries), 1.4 s on a synthetic set of 20 cameras x 400 pictures x 7 ROIs. It now runs inside `db.shared_connection()` (one connection reused by the calling thread; `close()` only drops unsaved work, other threads and code outside the block still get their own), 0.32 s. `/api/tags` was never slow (0.01 s); it only waited behind the Overview request. Any other page that reads many small things can use the same block. Not yet done: the picture-folder listing per camera (sorted `Path`s) is now the largest part and grows with the number of pictures.

- **Delete a camera (v1.52.0):** each camera on the Overview has **Delete camera…**. The warning lists what goes (files and size on disk, pictures, ROIs, labels, goldens, versions, detections, other records) and the **Delete camera permanently** button stays disabled until the camera's name is typed again; the API repeats that check (`DELETE /api/cameras/{camera}?confirm=<name>`, preview at `GET /api/cameras/{camera}/delete-preview`). `db.delete_camera_rows` removes, in one transaction, every row of every table that has a `camera` column (found from the schema, so a table added later is covered), the version items and results, and the `score_cache` vectors that only this camera's pictures use (a vector another camera's identical picture also uses stays); `datamodel.delete_camera` then removes the camera folder (pictures and exports) and the in-memory caches. A camera with a queued or running job is refused (409). Irreversible: there is no trash.

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
- **Ingest page layout (v1.70.0):** one page for everything that brings pictures in, in order: *1 · Add pictures* (upload files and import a folder side by side, with progress and the added / duplicate / error report), *2 · Ingested pictures* (the camera's pictures as the shared card grid `views/ValueGrid.tsx` with pager, columns, file-name search and the picture viewer; each card shows when it was ingested and the name it came in under), then *Maintenance* (rebuild the catalog). The **Ingested** filter narrows to All dates, Today, Last 7 days or one day (with its count); **Order** newest or oldest first (`ingestDays.ts`). The ingest time is the `created` column of `frames` (set when a picture is ingested; `ingest.rebuild_index` keeps it for known pictures, and uses the file time only for pictures it has not seen). `GET /api/cameras/{camera}/ingest/frames` lists the live pictures. **Prepared, not built:** tags on pictures (free text like the camera tags, probably a per-picture table and a tag filter next to the date filter); the date filter is where they will sit. Whether picture tags share the camera tags' vocabulary is still to be decided.

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

- **Outliers in the View switch (v1.57.0):** the switch is now **Grid | Scatter | Outliers**. Outliers is the Outliers tool of the Dedup pages (`classify/OutlierPanel.tsx`, shared) inside Classify (`classify/ClassifyOutliers.tsx`): choose the embedding, set k, press **Score outliers**, and the ROI's pictures are listed from the most isolated one as cards to label or delete on the spot (stamped `Outliers`); a label or delete reloads Classify's counts and grid. It uses Classify's own grid settings like the Scatter view. Scatter and Outliers share the embedding choice (`classify/useDedupState.tsx`, the Dedup setting of the ROI). The scores are not kept when you switch views; press the button again.
- **Grid | Scatter switch (v1.54.0):** Classify has a **View** switch under the class counts. **Grid** (the card grid with filters, always the default) or **Scatter**: the 2D map of this ROI's pictures, where dragging a rectangle selects many at once and one click labels them all as a class (for the product ROI: the products), clears them, or deletes them, exactly as on the Scatter page. The map code is shared, not copied: `classify/ScatterWorkbench.tsx` (the `useScatterMap` hook, `ScatterMapView`, `ScatterSelection`) is used by both the Scatter page and `classify/ClassifyScatter.tsx`. A map that is already computed appears at once (`GET /api/cameras/{camera}/dedup/scatter/cached`, `scatter.is_cached`: every live picture is part of the cached layout); otherwise a **Compute map** button runs the same projection job as the Scatter page. The Scatter view has its own Embedding, projection and Colour-by (label / cluster / nothing) choices; the embedding is the Dedup setting of the ROI. A label or delete from the map reloads Classify's counts and grid. The selection under the map uses **Classify's own grid settings** (pictures per page and columns, `classify/grid-settings`), so Grid and Scatter are one setting of the ROI (v1.54.1); the Scatter page keeps its separate `dedup.grid.*` setting.

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
- **Painting keys and deleting in place (v1.60.0):** on every label grid (Classify and the Scatter selection, Clusters, Outliers and Insights lists, all `Card`s) **X clears like 0** (press on the hovered card, or hold and sweep; the overlay and Verdict too, with the same grey cross cursor; the Detector keeps its red cross for X) and **Delete sweeps**: hold Delete and move over cards, and each unlabeled, non-golden card is deleted (a labeled card, a golden, or a picture outside the ROI's scope is never swept, because deleting clears its labels in every ROI; a single press on a hovered card still deletes it). Sweeps still never overwrite a label. The cursor for the Delete sweep is a dark circle with a bin on every grid. **A deleted card fades and stays where it is** (no reload, nothing moves, the Restore button is on the card, the numbers above update at once and are read again when the deletes settle) until the user turns the grid: another page, page size, columns, View or search, or a new list; then it is gone. Classify does it by updating the card locally and not reloading; the client lists do it once in the shared `PictureGrid` (`ghosts`, `onRestored`; the Scatter selection and Outliers take a restored picture back, Clusters cannot, so its faded card's Restore is disabled and points to Classify's *Show: Deleted*); the Detector review (Delete now sweeps there too, on cards you have not decided) drops its deleted cards when the grid is turned, while decided cards stay until Remove decided. Typing in the search field never triggers a key.
- Painting (v1.29.0, `classify/paint.ts`, used by every `Card`): hold a class key 1-9 and move the mouse over cards; each unlabeled card entered gets that label. Labeled cards keep theirs (change them with a single press) and goldens never change. Holding 0 clears labeled non-golden cards instead. Golden has no paint mode. The cursor becomes a dot in the class colour (OK green, NG red; grey cross for 0). Only real pointer movement paints (a scroll under a still pointer does not), each card acts once per stroke, and a stroke ends on key release or window blur. No stroke-level undo
- **Shared grid behaviour (v1.49.0):** every card grid works the same way and differs only in its keys, colours and what an action does. `classify/painter.ts` (`createPainter`) is the engine for "hold a key and sweep": the held key, the once-per-stroke set, the scroll guard and the **cursor**, which is a class on the page (`html.painting`, one rule the painter adds itself, `cursor: var(--paint-cursor) !important`) so it wins over the hand cursor of links and buttons, shows the moment the key goes down with the pointer over a card (not only after a move), and stays while the key is held. `classify/useGridCard.ts` is what every card uses: hover keys (Ctrl/Alt/Meta, repeats and typing never pass) and painting, with the page's callbacks `onKey`, `paint` and `cursorOf`; a card that unmounts under the pointer releases it. `classify/CardGrid.tsx` is the layout every grid uses (pager above and below, columns, a client-side page or a server page via `serverPage`, a header slot). Painters: labels on Classify and every `PictureGrid` page (`classify/paint.ts`: keys 1-9 and 0, class-colour cursor), the Detector review (`reviewPaint.ts`: A accepts, X/Delete clears, green tick / red cross) and Verdict (keys 1 OK, 2 NG, 0 or X clear; sweeping never overrides a decision of yours; the busy state is per frame so a quick sweep skips nothing). Users of `CardGrid`: `PictureGrid` (Scatter selection, Clusters, Outliers, Insights), Classify, Verdict, `ReviewGrid`.

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

- Dedup page panel: each live frame's mean cosine distance to its k nearest other frames (k 1-20, default 5) over the Dedup embeddings, so the feature's filter and mask apply
- Most isolated frames listed first as cards (label, golden, delete); the 2D projection can be coloured by the score
- Derived on demand (`outliers.py`, `api/outliers_api.py`, `classify/OutlierPanel.tsx`); no stored state. A review aid, not a verdict; independent of the clustering parameters

### Chain canvas (v1.51.0)

- A new **Chain** page (Overview section) draws the camera's processing chain as boxes and arrows (`ChainView.tsx`, `chain/chainModel.ts`, React Flow `@xyflow/react`). It is a view of the ROI definitions, not a second copy: a box is Ingest (one per camera, cannot be deleted) or one ROI, and every arrow is derived from the `rois` rows (`chain.py`, `GET /api/cameras/{camera}/chain`).
- **Classify box (v1.53.0):** the product-sorting ROI is followed by its **Classify box**, the labeling step that tells which picture belongs to which product. It exists whenever that ROI does (derived, so existing cameras get it; it cannot be deleted on its own and goes with its ROI), shows the pictures per product and how many are not labeled yet, and the **Classify** button jumps to the Classify page on that ROI. **Every feature ROI has one too (v1.56.0)**: after the feature box, its own Classify box shows that ROI's classes (OK / NG) with their picture counts over the pictures the ROI applies to and how many are not labeled yet; it has no product handles (only the product ROI's box has them), and the **Classify** button opens the Classify page on that ROI.
- Arrows: Ingest to the product-sorting ROI to its Classify box, and every feature ROI to its own Classify box (all fixed); Ingest to a feature ROI that applies to the whole camera; one **handle per product** on the **Classify box** to a feature ROI scoped to that product. Drawing a product arrow adds the product to the feature's shared `products` list, deleting it removes the product (none left = whole camera), and an arrow from Ingest puts the feature back on the whole camera (`PATCH /rois/{feature}/products`). A `<product>::<roi>` feature is drawn with a fixed (dashed, locked) arrow from its product handle; its scope comes from its name.
- Boxes are created with **+ ROI product** (product names, at least two; only one per camera) and **+ ROI feature**, which create real ROIs through `PUT /rois` (default rectangle; draw it in the ROI editor). **Delete…** shows what would be lost (labels, goldens, detections, versions, from `GET /chain/delete-preview`) and then calls the ordinary ROI delete; product-scoped ROIs of a deleted product-sorting ROI stay, as before.
- Only the layout is stored: box positions, display names (cosmetic; the ROI keeps its name) and viewport, in the `settings` key `chain.canvas` (`PUT /chain/layout`). Boxes without a stored position are placed below the others of their column. Wheel zoom, drag to pan, fit to view; the right panel renames, opens the ROI editor on that ROI, and deletes.
- **Feature ROI output handle (v1.63.3):** the fixed arrow from a feature ROI to its own Classify box was never drawn in a real browser, because a feature ROI box had no output connection point (only Ingest and the product ROI had one). Every ROI box now has one; the arrow stays fixed and cannot be drawn or deleted by hand. Found on the first real use of the Chain page.
- **No key numbers on the label buttons (v1.63.2):** the class buttons of the cards (Classify and the lists), of the picture viewer and of Verdict show only their label (OK, NG, the product names); the shortcut is in the hover hint ("Shortcut: hover the card and press 2 (X or 0 clears). Hold the key and move the mouse over cards to paint it on unlabeled ones." on a card, "Shortcut: press 2." in the viewers).
- **Rank using in the top bar (v1.63.1):** on the Classify page the top bar has a third picker after Camera and Product, **Rank using** (ResNet 50, ResNet 18, Classical), listing the methods in use on the Configuration page and shown only when there is a choice (two or more). It is remembered in the browser and shared with the page through `RankContext`; a method that is no longer in use falls back to the server's default (ResNet 50 when on). The Grid's options panel no longer has it.
- **Renaming a product (v1.63.0):** the *Products* list in the ROI editor (also in the editor opened on the product-sorting ROI from the Chain) is now one field per product (`classify/ProductNamesEditor.tsx`): change a name in place to **rename** it, + adds one, ✕ removes one from the list (its labels and ROIs stay, they are just not offered). Saving sends the final list and, for each renamed product, old to new (`PUT /api/cameras/{camera}/product-names` with `names` and `renames`), so a rename is never mistaken for a removal plus an addition. `products.py` checks it (the old name is a product, the new one is not in use by another product ignoring case, no `::`, slash or leading `@`, no ROI already named `<new>::...`; to swap two names rename one first) and `db.rename_products` moves everything in **one transaction** (all or nothing): the product list of the product-sorting ROI and the `products` lists of shared ROIs; the labels, goldens and version items of the product-sorting ROI (their `class`) and the version counts and statistics; the product's own ROIs `<old>::x` to `<new>::x` in every table keyed by feature (labels, goldens, versions, mutes, results, scatter and cluster caches, detections) with their settings keys (`vision.<feature>`, `grid.cols.<feature>`, ...), the cached vectors (copied, so nothing is computed again) and the Chain layout (box positions and names). So the labels, the goldens and the arrows to the following feature ROIs stay connected. After a save the app keeps the renamed product and ROI selected and reloads the product list in the top bar (it follows any change now). Exports already written to disk keep the old names.
- **Options panel on Classify (v1.62.0):** Classify has the collapsible right-hand panel of the Dedup pages (`SidePanel`, `wide` = 300 px; open or closed is remembered for every page), and it shows the properties of the selected view. **Grid:** Show, Order by and Show muted (Rank using moved to the top bar, v1.63.1), and the Bulk-label, Clear and Auto-assign tools (all off while a search is active); the suggested goldens stay in the page, since they are a list of pictures. **Scatter:** Embedding, Projection, Colour by, Compute / Recompute map and its progress. **Outliers:** Embedding, the k slider, Score outliers and its progress. The Scatter and Outliers views write their controls with `PanelPortal` (`SidePanel.tsx`): they appear in the panel while it is open, are not shown while it is collapsed (the hints in the page then say they are in the options panel), and stay inline where there is no panel (a view rendered alone). `PanelSection` is the titled block with the info tip; the info texts are shared with the Dedup pages (`classify/toolInfo.tsx`). The numbers, the navigation line and the search stay in the page.
- **Clickable numbers, live pictures only (v1.59.0):** the strip above the Classify grid is now a row of boxes (`classify/ClassifyKpis.tsx`): **Frames** (with "of N" when the ROI covers only some products, N being the camera's pictures that are not deleted), one box per **class of the ROI** with its ⭐ golden count (the products for the product-sorting ROI, OK / NG for a feature, in the class colours used on the buttons and the map), and **Unlabeled**. They count only the pictures the user works with: **not deleted and not muted for this ROI** (`labels.live_counts`, used by the Classify state and every Classify action's answer; the shared `labels.counts` that Status and the version records use is unchanged, so those pages still count every picture). A box is a shortcut: it turns the grid to the matching View (All, Labeled <class>, Unlabeled), from Scatter or Outliers too, and it ends a search. Deleted and muted pictures have no box.
- **Classify says less (v1.58.2):** the page no longer carries the "Shared ROI - one golden set and one label set" paragraph, the "Start here: mark a few reference frames" hint, the "Methods / neural device / cached" line (the hardware badge shows the device), or the "Rank using and Order by are greyed out" hint. **Refresh scores** moved onto the navigation line (after Back to chain and Grid / Scatter / Outliers, or after the switch on the plain page), shown while the Grid view is selected, with what the page has to say about the scores (nothing scored yet, goldens changed, a method switched on, the frame set changed, the running progress, or the result "Scores refreshed — N frames") to its right on the same line. The bars explanation under the scored grid stays.
- **Search by file name (v1.58.0):** every card grid's pager has a magnifying-glass button (the first button, top and bottom share one field; Esc or the icon again closes it and clears the search). In a list the grid holds (Outliers, the Scatter selection, the clusters, the Detector review) it filters that list by the part of the name typed, ignoring case. In **Classify's main grid** it searches the **whole camera** on the server (`GET classify/grid?search=`, `_search_grid`): deleted and dedup-muted pictures and pictures outside the open ROI's scope included, whatever the View, after a 300 ms pause in typing; the answer is the usual cards in name order, paged, with "Not found" when nothing matches. The grid and its cards stay as they are, with two flags: a picture **outside the ROI's scope** (another product, or no product yet; a deleted picture is never flagged, its product label is gone) has a **red frame** and a hover hint naming its product, and a **muted** picture has a dark grey dashed frame. On an outside picture the card's own OK / NG, golden and number keys are locked. **Clicking a found picture opens the shared viewer** (`FrameViewer`). In a feature ROI the label line starts with a **Product** row (`classify/SearchExtras.tsx`, `ProductRow`: the product-sorting ROI's classes, the picture's own product pressed; `PUT classify/label` on that ROI) so the product can be seen and corrected on the spot, followed on the same line by the ROI's own buttons captioned **Feature** (OK / NG, golden) and, for a picture the duplicate step has hidden (**muted**), a **Show again** button (`POST classify/unmute`). There is no button to mute a picture by hand: Delete is how a picture is got rid of, and the duplicate step does the muting (a cluster **Apply** reconciles all mutes of an ROI). The warning for a picture outside the ROI's scope ("Outside this ROI: in product B. Set its product first.", and "Hidden by duplicate removal.") is a one-line note on the **zoom line** (beside − + Reset 1:1 and the percentage, `SearchNote` through `FramePane`'s `info`), so nothing in the viewer changes height when it appears. The OK / NG buttons of an outside picture unlock when its product fits. Delete / Restore and the ROI's labels are the viewer's own (v1.61.0). While a search is active the bulk, clear, auto-label and suggest tools are switched off.
- **Classify locked to the ROI (v1.57.1):** the **Classify** button on a box opens `/classify?focus=<ROI>`: the page works on that ROI only, without the ROI dropdown (its scope was decided on the canvas), with the ROI's name in the heading and **← Back to chain** on one line with the **Grid / Scatter / Outliers** switch (v1.58.1; the plain page keeps the switch under the counts). The plain Classify page from the menu (and from the Overview) keeps its dropdown.
- **Short buttons (v1.56.1):** selecting an ROI box (the product ROI too) shows two buttons in the right panel, **ROI editor** and **Classify** (the Classify page on that ROI); the Classify box shows **Classify**, Ingest shows **Ingest**.
- **Focused ROI editor (v1.55.0):** the **ROI editor** button on an ROI box opens the ROI editor locked to that one ROI (`/roi?focus=<ROI>`; the plain `/roi` from the menu is still the full editor). Whether it is the product-sorting ROI or a feature was decided on the canvas, so the page shows only that ROI's own rectangle (no other ROI is drawn), offers no drawing of new ROIs, no product-sorting option, no list of ROIs, no "applies to products" and no delete (the canvas owns those), and has a **← Back to chain** button. Moving and resizing the rectangle, the reference frame and the zoom work as before; for the product-sorting ROI the product names stay editable. A feature ROI is drawn on the whole picture: the product ROI only separates products and does not limit later ROIs, and the geometry is stored as before (full-frame fractions).
- **Measurement boxes (v1.66.0):** the Chain gets three more boxes, **+ Detector**, **+ Calculate** and **+ Evaluation**, for the analysis a person does by eye: find named targets, compute a number, compare it with nominal ± tolerance. Plan and decisions: `plans/detector-calc-chain.md`.
  - **Own page per box (v1.66.1):** the Chain only shows the box and a button (**Detector** / **Calculate** / **Evaluation**) that opens `/flow?focus=<box id>` (`views/FlowBoxView.tsx`), laid out like the ROI editor: ← Back to chain, the options in the right panel (`FlowBoxPanel.tsx`), the work in the middle. Detector: the picture always shows; drag a rectangle around what to find and then name it (so the target is created from the picture), draw / place tools, target chips, a thumbnail strip coloured by complete / to review. Calculate and Tolerance: histogram and a list of every picture's value, sorted, with **Use as nominal** on any picture.
  - **Detector** (`flow.py`, `rotsearch.py`): named targets, each with example crops drawn on a picture (**Draw example** on the box's page; the crop is stored with the target as a small PNG). The search is rotation-aware (coarse-to-fine, sub-pixel centre, angle), so a part turned any way is found; the identity of a target is its name. A second detector drawn from the first searches **inside the found boxes**; its page (v1.66.3) shows one picture per box the first detector found for the chosen target, zoomed to that box plus the padding, and the example is drawn there (the target chips are the first detector's target names) (target "A" looks inside box "A"; padding setting), without turning. Run is a background job; results are stored per frame hash (`flow.det.<id>`) and go stale when an example or setting changes. A picture where a target is missing is listed for review; a click on the page places the box, and a box a human placed survives the next run.
  - **Drawing offset fixed (v1.71.1):** on the detector page the stage (`.flow-stage`) was wider than the picture (its width came from the picture's natural size while the picture itself was capped at 760 px), so the drawing overlay covered an empty strip and mapped the pointer to the wrong place: rectangles started away from the cursor and the stored example did not match what was drawn. The stage is now exactly as wide as the picture. Checked in headless Chrome on a temporary camera: the drag rectangle starts at the cursor and the stored example equals the source region pixel for pixel.
  - **Same canvas as the ROI editor (v1.71.2):** the detector page's picture is the shared `ZoomPane`: wheel zoom at the cursor, pan with the middle button or Space + drag, − / + / **Reset** / **1:1**, the zoom percentage, the pixel under the pointer and the rectangle size while dragging, and the same **Picture size** slider (remembered). A rectangle being drawn or selected looks like the ROI editor's (red border, translucent orange fill, red square handles with a white edge, 12 px at any zoom); saved examples and found boxes have a dark line under the coloured one so they show on a white part of the picture. Checked in headless Chrome: zoomed to 252 %, a drag lands under the cursor and the stored example is the exact region.
  - **Geometry in the viewer (v1.72.0):** on the Calculate and Evaluation pages the picture opened from the grid shows how the number came about (`views/CalcGeometry.tsx`, shapes in `calcGeometry.ts`, mirroring `flow.compute`): the two found boxes (turned as found, A orange, B blue) with their centres and names, and per operation - **angle**: the line A → B, a dashed reference ray to the right and an arc from it, counter-clockwise on screen or clockwise with the toggle, with the value; **distance**: the line and its length; **dx / dy**: the legs of the right triangle, the measured one solid, the other dashed. A picture where a point is missing draws the box it has and says which is missing. Behind a Crop box the viewer shows the cut-out the boxes are in (`FramePane` takes an `imageUrl` and an `overlay`; the Calculate detail names its `input` detector and `crops`). Checked in headless Chrome: 24.2° / 335.8° for the same points with the toggle, 537.1 px, dx 490, dy 220.
  - **What a found position is (checked v1.72.1):** the position of a found target is the **centre of the example box** that was drawn (at the found turn), not of whatever is inside it. A target drawn as "hole plus the geometry next to it" is therefore found with its centre between the two, off the hole by the offset of the hole inside the example; for the hole's own centre a second detector inside the found box (its example is the hole alone) is needed, or a reference point per target (not built). Positions are pixel indices (centre of a 36 px box starting at pixel 52 = 69.5); everything that draws or cuts with them adds half a pixel (`pixelCentre.ts`, `anchor._on_frame`), and a clicked *Place box* point is stored back minus half a pixel. Before v1.72.1 the drawing, the Calculate geometry and anchored ROIs were half a pixel up and left.
  - **Own target names in a cascade (v1.73.0, plan `plans/cascade-targets.md`):** a detector behind another detector names its own targets ("hole left detail") and each one has an `inside` link: the input detector's target whose found box it searches in (widened by the search area). One parent box can hold several targets; the link is changed in the right panel (*Searches inside*); a target without a link (made before) falls back to the same name. On the page, *Search inside* chips (the input detector's targets) choose which box and pictures are on show; below them this detector's own targets and *+ New target*: a drag adds an example to the selected target or starts a new one (name suggested as "<parent target> detail"); choosing another parent box switches to a new target. A picture with no box for the linked target is skipped for that target and goes to review. Calculate, the Anchor dots and the rest see the child's own names. Checked in headless Chrome on a temporary camera. Before this, drawing in a cascade created a second target with the parent's name.
  - **Large examples (v1.75.0):** an example whose longer side is over 400 px (`flow.MAX_EXAMPLE_SIDE`) is no longer refused. It is stored shrunk to 400 px (`scale` on the example, kept only when below 1, so examples and detector signatures that never needed it are unchanged) while its `box` stays in picture pixels. A detector shrinks every picture and all its examples by one factor, the smallest `scale` of its examples (`flow.match_scale`; nothing is ever enlarged), searches there, and takes each found centre back to picture pixels; the stored box keeps the example's own width and height, and the search area of a cascade (parent box, padding) is scaled with the picture. The position is as exact as about 1 / scale pixel. An example that would make another one of the same detector drop under 8 px after the shrinking (`MIN_MATCH_SIDE`) is refused with that reason. Checked on synthetic 1000 px pictures with a 500 px pattern (found within 2.5 px, also inside a cascade), **not on real camera frames**. The per-example `scale` is in `GET /flow/nodes/{id}`; the page does not show it yet.
  - **Box handling like the ROI editor (v1.75.1):** on the detector page the cursor now says what a press would do: the resize arrows of the handle (`HANDLE_CURSOR` in `roiGeometry.ts`, shared with `RoiCanvas`), a move cursor inside an example, the crosshair elsewhere (also while a handle is dragged); the example under the pointer gets a light fill before it is selected. Dragging stays inside the picture on show: the pointer is clamped to it, and `resizeRect` never crosses the top or left edge and, given the picture size, not the bottom or right one. Checked with component tests (jsdom) only, **not clicked through in a real browser**. **Not yet:** dragging a found box on the page (found boxes are still set with *Place box*).
  - **Detector page keeps the right picture (v1.75.2):** the picture size used for the overlay and the zoom window is now remembered together with the picture it was measured on (`measured.src`), instead of being reset to "unknown" by an effect on every picture change. Before, a picture that loaded at once (cached) could report its size before the reset ran, the size was thrown away and the page stayed on its 4:3 placeholder (stretched picture, no boxes) until a hard refresh. Answers of `flowBoxes` (own and parent detector) that arrive late no longer replace newer ones. The other pages (`ZoomPane`, `RoiCanvas`, `LineCanvas`, `classify/FramePane`, `ShapeCanvas`) update their size on load without a reset and did not have this pattern. The cause is inferred from the code and a component test, **not reproduced in a real browser**.
  - **Editing an example (v1.66.4):** click an example rectangle on its picture to select it, drag inside to move it, drag a handle to resize it; it saves on release (`PUT .../examples/<target>/<index>`, the crop is cut again from its own picture) and the detector shows *run again*.
  - **Calculate:** two points A and B (since v1.74.0 chosen by the lines drawn into the box, see *Lines and points* below; before, one detector in), operation Angle A to B / Distance / dx / dy. The angle is that of the vector from the centre of A to the centre of B: 0° points right, 0–360°, with a counter-clockwise / clockwise toggle for the positive direction (the code handles the picture's y axis pointing down).
  - **Evaluation** (called Tolerance until v1.67.x; old boxes `tol:N` are renamed `eval:N` the first time the graph is read, with their arrows and Chain layout): nominal (typed, or a click on a histogram bar) ± tolerance; an angle wraps around (359° and 1° are 2° apart). Live counts pass / fail / undetermined (missing input or no nominal = undetermined). An arrow from the Evaluation box to a feature's Classify box shows the value and verdict on that feature's cards and adds the **Show → Measurement: pass / fail / undetermined** filters; a freeze records nominal, tolerance and counts in `stats.rules.measurement`. It is an opinion; nothing is labeled automatically and it is never blended with the scores.
  - Storage needs no schema change: boxes and arrows in the setting `flow.graph`; arrows are typed (Ingest or detector → detector, detector → Calculate, Calculate → Evaluation, Evaluation → Classify). Layout still lives in `chain.canvas`. Deleting a box shows its arrows and stored detections first. Endpoints: `/api/cameras/{camera}/flow/...` (`api/flow_api.py`).
  - **Cascade rules (checked against `flow.run_detector`):** a downstream detector searches, per target, only inside the box the upstream detector found for the same target name, widened by its padding. A target the upstream detector did not find on a frame is skipped there and the frame goes to review. The downstream search turns only if its own rotate setting is on; the upstream angle is stored but not applied to it. The upstream detector must be fresh before the downstream one runs.
  - **Arrow routing (v1.66.5):** Chain arrows are `smoothstep` (orthogonal), so a line between stacked boxes does not hide behind them.
  - **Detector-anchored ROI (v1.67.0, reworked v1.71.0):** every target of a detector box has its own **dot** on the box (like the product dots of a Classify box); **drag a dot onto an ROI feature** and the ROI follows that target's box (the arrow leaves from the dot; delete the arrow or **Remove anchor** to make the ROI static again; one anchor per ROI, a second dot replaces the first). The **Anchor** section of the ROI box (right panel) sets how, in two modes: **the found box (plus a margin)** - the default of a dropped dot, nothing to draw, the ROI is the axis-aligned box around the found, possibly turned, example grown by the margin (default 10 % per side) - or **my own rectangle, related to the box** - you draw it in the ROI editor on an example picture and it keeps its place relative to the box on every picture (optionally turning with the detected angle). In the second mode the offset is read from the ROI's *current* rectangle, so redrawing it needs no new anchor; the ROI editor opens on the example picture (locked) with the detector's found box outlined in green. Pictures where the detector found no box have no ROI: scoring, vectors, thumbnails (404), the per-ROI Detector and Edge angle skip them, and the picture viewer outlines the rectangle where it lies on that picture or says there is none. A turned part is not straightened. Details: `docs/data-model.md`, `anchor.py` (`Source` loads the detector results once per run), `PUT/GET/DELETE /rois/{feature}/anchor`, `GET /rois/{feature}/rect?frame=`. Plan: `plans/detector-to-roi.md`. **Not yet:** a "no anchor" badge and filter on the Classify cards (their thumbnails are blank for those pictures), straightening a turned part, dots onto Calculate or a Crop, a detector behind an ROI or Classify (with an OK / NG class filter), a check on real frames.
  - **Evaluation page (v1.68.0):** the Tolerance box is now the **Evaluation** box (the name leaves room for other verdicts; nominal ± tolerance is its first rule). Its page shows the pictures as the usual card grid (`views/ValueGrid.tsx`: pager, columns, search by file name, the shared picture viewer; each card has its measured value, the verdict and **Use as nominal**; nothing is labeled there; Calculate uses the same grid without verdicts). The histogram can be hidden with the **Histogram** tick box (remembered in the browser). **Zoom:** drag across the chart (not on the band) to zoom the x axis into that range; the values in it are binned again, so a peak shows its detail, and the grid narrows to the pictures in the range (chip *range a–b* with ✕); right-click on the chart or the chip restores the full view. A click on a bar still takes its value as the nominal; a drag does not. Backend: kind `evaluation`, ids `eval:N`, `flow.evaluation_state`; the numbers `nominal` and `tolerance` keep their names.
  - **Lines and points (v1.74.0, plan `plans/chain-lines-and-points.md`):** *Magnetic anchor points:* a dragged arrow snaps to the nearest valid anchor point within 40 px (`connectionRadius`), each dot has a large invisible hit area and grows green while it is the one that will take the arrow. *No automatic lines:* a new Crop, Detector, Calculate or Evaluation is placed without a line; only the **first** box of an empty flow graph that can follow Ingest (Crop, Detector) is joined to Ingest (`flow.create_node`). An ROI still comes with its Classify box and their line. Existing graphs keep their lines. A picture box with no line reads the whole picture, so deleting a line (including an Ingest one) leaves the box unconnected instead of reconnecting it. *Moving:* dragging an ROI carries its Classify box, dragging the Classify box moves it alone (`classifyFollows`). *Deleting a line:* click it (it turns blue) and press Delete or Backspace; edge selection never worked before because the edges are a controlled list (found in the browser check). A box is still deleted by its own confirmation; the Delete key no longer drops its lines first. *Calculate points:* a detector has its main dot (the whole detector = all its targets that have examples) and one dot per target; an arrow from a target dot into Calculate carries that one point (stored as `point` on the flow edge). Calculate takes two points in all, from any mix of arrows (two of A, one of A and one of B, or the whole of a two-target detector); a third is refused, with more than two (a whole detector with three targets) the A / B choice still picks two. The two points may come from different detectors: each is shifted by the offset of the crops above its detector, so distance and angle are measured on the whole picture (no resize, so a crop changes positions, not distances). The Calculate page shows the geometry only when both points come from one detector. Checked in headless Chrome on a temporary camera (drops 22-25 px off the dot, ROI drag, select and Delete). **Not yet:** the Calculate page's picture for points of two detectors.
  - **Crop box (v1.69.0, plan `plans/crop-box.md`):** **+ Crop** adds a picture step to the Chain. One rectangle (stored as fractions of its input picture, the same for every picture; none drawn = the picture passes on unchanged) cuts each picture before the next box; nothing is written to disk. Its page (`views/CropWork.tsx`) is the ROI editor's canvas (`RoiCanvas` on `ZoomPane`: wheel zoom, pan, Reset, 1:1, picture-size slider) on the picture that enters the box, with a picture picker; draw, move or resize the rectangle and it is **saved when the pointer is released**; **Clear crop** removes it; the cut-out is shown as the result. Arrows: Ingest or a Crop → a Crop or a detector (one input per box; since v1.74.0 taking a Crop out leaves what it fed unconnected, which reads the whole picture like Ingest). A detector behind a Crop works on the cut-out: its page shows the cut-out (`GET /flow/nodes/{id}/picture?frame=&stage=&size=`), examples, found boxes and human boxes are in the cut-out's pixels (angles unchanged, no scaling), results go stale when a Crop above changes, and a cascade shares its input detector's picture. An ROI anchored to such a detector adds the crop offset back (`anchor._on_frame`), so it still lies on the whole picture. Backend: `flow.input_rects / apply_rects / rect_offset / picture`. **Not yet (left open on purpose):** a Crop fed by an ROI or a detector, a detector behind an ROI or Classify box, a real resize or other picture steps, and the **resolution warning** below.
  - **Parked: warn about mixed resolutions.** If one camera's dataset holds pictures of different sizes, crops (fractions) give different pixel sizes and pixel-based settings (detector example sizes, distances) do not carry over. The app should show a warning (Ingest / Overview / Crop page). Not built.
  - Next steps (edge routing, Evaluation leftovers, detector-anchored ROI with its open decisions): `plans/chain-next-steps.md`.
  - **Draggable band (v1.66.6):** on the Evaluation page the histogram shows the nominal ± tolerance band; drag its middle to move the nominal and either edge to change the tolerance (saved on release through the ordinary box update; bars inside the band are marked live while dragging). Clicking a bar still takes its value as the nominal.
  - Not yet: lines and edge-angle as a box, circle fit, a Merge box, running the whole chain from one button. The old per-ROI Detector page is unchanged. Not calibrated on real frames yet: check the angle precision (about 0.3–0.5° expected for 35–45 px holes) on your pictures.
- Plan and parked items: `plans/chain-canvas.md`.

### Navigation (v1.42.0-v1.50.0)

The sidebar is gone. A top bar holds the four sections (Overview, Management, Manipulation, Export; working names), the camera and product pickers and, on the right, ⚙️. Overview and Manipulation show a second-level bar of their pages/tools under it; the section button returns to the page last open in that section. A slim fixed **status bar** at the bottom (`StatusBar.tsx`) shows camera › product › ROI on the left and the hardware badge and app version on the right. The ROI editor is a Manipulation tool (a helper for focusing on a detail), not a setup step. In Manipulation, **Scatter, Clusters, Outliers** (group label "Duplicates", `/dedup/:tool`, `/dedup` redirects to Scatter) are three separate tools in the second-level bar. The right options panel scrolls independently of the centre (`.right-panel-body`; the column height follows the measured top-bar height in `--top-h`). **Tool icons (v1.44.0):** each tool in the second-level bar has a drawn two-tone icon (`ToolIcon.tsx`), muted grey until the tool has left a trace on the camera, in its own colour after (Overview and Status are always colourful). Used means: stored settings/results (Clusters mutes or snapshot, ROIs, Detector filter/mask/detector, Edge angle rule, Augmentation settings, versions, Verdict decisions) or an action made from the tool (a label whose `labels.via`, or a delete whose `deleted_frames.source`, names it). Just opening a tool does not count. `tools_used.py` derives it on read (no stored state, no schema change), `GET /api/cameras/{camera}/tools-used`; `App.tsx` reloads it on camera change and after data changes. Scatter, Clusters, Outliers and Insights now pass `via` with their label/delete calls (optional `via` on `PUT classify/label`, `POST classify/delete` and `delete-bulk`). Limit: a frame has one label row, so a later relabel by another tool overwrites `via`, and older labels/deletes stay unattributed. **Shared picture grid (v1.45.0):** `classify/PictureGrid.tsx` is the one component behind the card grids that show a client-side list of frames: the Scatter selection, Clusters, Outliers and the Insights matrix cell. It owns the pager (above and below), the card grid, the busy state and the picture viewer, and sends every label, golden and delete through one place, stamped with the tool name (`via`). Each successful change is reported once: `onChanged(frame, card)` (label, golden, restore) or `onDeleted(frame, card)`; the tool keeps the frames, marks and page. Insights runs it with `viewer={false}` and `restorable` (its cells keep deleted cards, as before). Classify (server-paged cards with scores) and Verdict (decision cards) keep their own grids; the app-wide "something changed" event is still `DATA_CHANGED` in `api.ts` (fired by every non-GET request). Still to do from `discussions/picture-sorter-ui-navigation-handover.md`: the "frame position" part of the status bar (not found in the app; only camera/product/ROI are shown), then the other pages' options panels.

### Dedup page layout and the options panel (v1.31.0-v1.43.0)

The Dedup page is the trial ground for a new page layout; the plan is to copy it to the other pages once the user is happy with it. **None of it has been seen in a real browser by Claude, or used on the real cameras**: it is covered by tests only.

- **Options panel** (`SidePanel.tsx`): a collapsible panel on the right (`»` hides it; collapsed state is remembered in the browser for every page). It holds, top to bottom: Embedding, Feature (ROI), then the controls of the **selected tool** (Scatter, Clusters or Outliers, each with a title and an info tip; `ToolControls` in `DedupView.tsx`). The product is chosen in the top bar. A status card above the panel shows the number of frames in scope (hidden while the panel is collapsed).
- **One tool at a time:** the top bar picks the tool (v1.43.0 replaced the accordion groups and the "● active" tag). `DedupView` is one component for all three tools (one route `/dedup/:tool`), so each tool's results are kept while another is selected: switching back shows them at once. Outlier scores are discarded when the ROI or the embedding changes; a scatter map is dropped when the embedding changes and refreshed when a new clustering is made.
- **Clusters tool:** Epsilon and Min points (`WheelRange` sliders, they also answer the mouse wheel), then one line with 🔍 Cluster, ↺ (revert the sliders to the last clustering) and 🔇 (apply mute; disabled when nothing would be muted or Clusters is not active), and the line "N frame(s) will be muted". The centre has a row of equal-width tabs ("0 (12)", ... "Unique (3)") above the shared paged card grid. Each tab has a bottom line in its cluster colour (per-side border longhands; mixing `border` with `borderBottom` once made React drop the colour); the selected tab is bold with a translucent wash of its colour. The representative is the card marked "◉ rep".
- **Scatter tool:** projection (UMAP/t-SNE), Colour by (cluster / label / outlier score / nothing; falls back to labels with a note when the data does not exist), Compute projection. The map fills the centre width with a legend. `POST /dedup/scatter` takes `method` (the embedding) and needs no clustering; it returns each point's `label`, `golden`, and `cluster`/`representative` only when a clustering for that embedding is held. The frames in the dragged rectangle appear in the shared paged card grid under a button row between map and grid (class-coloured "Label N as X" in one group, a red "Delete these N frame(s)…" apart); labels, goldens and deletes made there show on the map without projecting again (`overrides` in `DedupView`).
- **Outliers tool:** k slider (wheel) and Score outliers; result cards in the centre (`useOutliers`, `OutlierControls`, `OutlierResults` in `classify/OutlierPanel.tsx`).
- **Info tips** (`InfoTip.tsx`): explanatory text moved off the page into an "i in a circle" icon in a group's title row, shown on hover or keyboard focus. The headings and paragraphs it replaced are gone, as are the "Hover a card and press 1 ..." hint lines above the card grids of Classify, Insights, Outliers and Verdict (shortcuts live in the buttons' hover hints; class buttons also say how to paint with a held key). The plan is to treat the other pages' explanatory text the same way.
- **Picture viewer (shared since v1.48.0):** `classify/PictureViewer.tsx` is the one overlay shell: browsing (◀ n / N ▶ and the arrow keys), a page toolbar slot, picture tools, the picture area (given the width the window leaves), the **file name under the picture** (selectable, wrapping; long names no longer take room at the top), a hint line, Esc, and key capture (keys are taken in the capture phase and stopped, so the cards under the overlay never act too). Pages supply `toolbar`, `tools`, `onKey` and the picture. `classify/FramePane.tsx` is the full frame in a zoom pane with an optional yellow outline (zoom and pan kept across frames); `classify/useBrowse.ts` follows the shown frame while the list shrinks (a deleted or decided frame leaves: carry on with the one in its place, close when none is left). Users: `FrameViewer.tsx` (labels, golden, delete / restore, ROI outline; used by `PictureGrid` for the Scatter selection, Clusters, Outliers and Insights, and by Classify for the cards of the page shown), `VerdictViewer` in `views/VerdictView.tsx` (1 OK, 2 NG, 0 clear), and the Detector review editor in `views/DetectorView.tsx` (an editable `RoiCanvas` on the filtered crop: Enter or A accepts and moves on, Delete or X clears, Z undoes). Clicking a card's picture opens it (Ctrl/middle click still opens a tab). Deleted frames kept on show (Classify "Deleted", Insights cells) cannot be labeled in the viewer and have a Restore button.
- **Product picker:** the product is one app-wide choice (remembered per camera), picked in the top bar on every page. No page carries its own picker (v1.42.0 removed `PRODUCT_IN_PANEL` and the Dedup panel picker).
- **Status bar right side and ⚙️ (was the sidebar foot until v1.42.0):** a hardware badge (`HardwareBadge`, from `GET /api/device` = `embedding.device_info()`: kind amd/nvidia/cpu, label, card/CPU name, compute API, and a hint when a GPU exists but the installed PyTorch cannot use it), in the bottom status bar beside the app version and date; the icon-only ⚙️ Configuration link sits at the right of the top bar (clicking it again on Configuration returns to the previous page). The badge has three looks (card picture, chip row, banner); clicking it cycles them and the choice is kept in the browser. The pictures are drawn SVGs. **The user has not yet chosen a look; the other two and the click-to-cycle are to be removed once they do.**
- **Step bar:** every successful non-GET request fires a `picturesorter:changed` window event (`api.DATA_CHANGED`); the step bar reloads its pipeline 300 ms after the last one, so the "N of M frames labeled" count follows labeling without a page change.
- **Remembered in the browser** (`lastSession.ts`, `picturesorter.*` keys): last camera, product and ROI per camera, last page, panel collapsed, hardware badge look. The root address redirects to the last page.
- **Other:** `run.sh` prefers `.venv-rocm` when it exists (`PICTURE_SORTER_VENV=.venv` forces the CPU environment). The ROI editor's delete confirmation sits inline on the right of the row. The Overview "New camera" form is one line.

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
- **Only goldens (v1.64.0):** a project version freezes by default only the pictures that are golden (OK / NG) in at least one ROI and have a valid verdict (`versions.project_candidates`, `labels.quality_golden_frames`; product-sorting goldens do not count); the verdict decides the class and the golden mark decides that the picture is exported. A tick box **Only goldens** (default on, `goldens_only` in `POST /project-versions`) takes every verdict picture when unticked. The version records `not_golden` (verdict pictures left out for having no golden mark) in its counts and `stats.export.goldens_only`; `GET /project-versions` returns `golden_verdicts` (what a goldens-only freeze would take now). Earlier project versions (v1.27.0-v1.63.x) contain every verdict picture.
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
- `app/backend/flow.py`, `rotsearch.py`, `api/flow_api.py` — detector / Calculate / Evaluation boxes and the rotation-aware search (v1.66.0)
- `app/backend/chain.py` — the Chain canvas as a view of the ROIs: boxes, derived arrows, per-box status, layout in the `chain.canvas` setting (v1.51.0)
- `app/backend/products.py` — renaming a product with everything that carries its name (`db.rename_products`, one transaction; v1.63.0)

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
- `app/backend/rotsearch.py` — rotation-aware template search (v1.65.0, plan `plans/detector-calc-chain.md` phase 1; no UI yet): finds an example crop in a picture at any turn (coarse step on a shrunk copy, fine step on the full picture, parabola for sub-step angle and sub-pixel centre), `find_targets` for named examples, `region=` to search inside another match's box. On synthetic pictures with a planted asymmetric pattern: centre error about 0.07 px, angle error about 0.2 deg, 150-250 ms per picture (250-500 px, 40-64 px example); checked with `benchmark_rotsearch.py` and on OpenCV 4.8 and 5.0. **Not checked on real camera frames.** Angle convention: degrees, counter-clockwise as seen on screen.
- `app/backend/neighbors.py` — nearest unlabeled frames to a labeled seed, and the guarded batch-apply of the seed's label
- `app/backend/classify_view.py` — presentation-neutral filtering, sorting, bars, bulk and auto-assign selection
- `app/backend/suggest_goldens.py` — most-uncertain, diversity-spread golden suggestions
- `app/backend/insights.py` — per-method confusion matrices
- `app/backend/thumbs.py` — bounded-cache ROI cutout and square thumbnails
- `app/backend/preprocess.py`, `masking.py`, `vision_settings.py` — per-feature OpenCV pre-processing filters and rectangle/circle/polygon object masks (dark-grey outside) applied to ROI crops before features/embeddings (Detector page)
- **Detector review (v1.48.0, reworked v1.50.0):** v1.50.0: the cards have icon-only buttons (✓ accept, ✕ clear box, 🗑 delete picture, ↶ undo; the hover hint names the key); **Delete deletes the picture** through the same `POST classify/delete` as every page (`via` "Detector"; never painted), **X clears the box**, A/Enter accepts, Z undoes a decision or a delete (a deleted card stays in place dimmed, `ghosts`, until the grid is reseeded; undo restores the frame through `classify/restore`); painting is A and X only. `reviewList.ts` holds the filter (Needs review, Unsure, No detection, Trusted, Accepted = `human` + `reviewed`, Adjusted = `human` + `manual`, All; each with its count) and sort (least / most confident, file name, furthest / nearest to the first exemplar's centre; frames without a box last) logic; both choices are kept in `lastSession`. The review header shows only those two choices and a hover tip with the keys (the keys are no longer written out on the page). Detection runs on the **filtered** crops for both methods: `detector._filtered_crop` applies the saved filter to every frame and to the exemplar crops (tested in `FilterBeforeDetectionTests`). Earlier text: `ReviewGrid.tsx` is the queue as a paged card grid (page size and columns remembered in the browser). A decision (accept, clear, undo) shows **at once** and the card stays in place; the save runs in the background and is undone on screen if it fails (`DetectorView`: `order` = the frames in the grid, kept stable; `overrides` = decisions shown before the server confirms; `pending` guards stale list answers). **Remove decided**, leaving the step or switching Show all reseeds the grid from the server. **Painting (v1.48.1, `reviewPaint.ts`, on the shared painter since v1.49.0):** holding A (accept) or X / Delete (clear) and moving the mouse over the cards acts on every card the pointer enters, once per stroke, only on cards with a box that are not already your decision (`state` not `human`), so a sweep never overrides or clears an accepted box; the card the key was pressed on is marked handled; a scroll under a still pointer is not a sweep; the cursor shows a green tick or red cross while held. Undo (Z or the ↶ button, per card, one level) puts the frame's detections back through `POST /cameras/{camera}/vision/{feature}/detections/{frame}/restore` (`detections.restore`: rows `{x, y, w, h, conf, status}`; auto rows get the current signature). No preview is rendered for the grid (the preview hook gets no frame while only the grid is shown). Measured on temporary data: saving a decision about 6 ms and reloading the list about 7-17 ms for 200-1000 frames, so the earlier lag was the card vanishing and the queue reflowing, not the server.
- `app/backend/detector.py`, `detections.py` — exemplar-based object detector with two **methods** (`detector.method`, v1.47.0): **template matching** (default; `cv2.matchTemplate` with normalised correlation of the exemplar crop over each frame; the stored box has exactly the exemplar's size, the confidence is the correlation, up to `topk` separate peaks per exemplar, textureless exemplars skipped; about 1.5 ms per frame on the CPU, no torch or model) and **model** (OWL-ViT, optional `requirements-detector.txt`; its boxes take the exemplar's size centred on the model's own box, `sized_like_exemplar`, because the model often returns a region far bigger than the object and its confidence is relative to the frame's best box). On shifted photographs (`benchmark_detector.py --photos`) template matching found the object on every copy with 0 px error while the model's box was far off on most. Backend pluggable (tests). Run needs the model only for the model method (`vision_api.detect`). **speed (v1.45.2, v1.46.0):** the default backend encodes each exemplar once per run (`_query_embeds`, cached) and each frame once for all exemplars, takes frames in batches of `BATCH` (8), and does the non-maximum suppression in numpy (`_boxes_above_nms`) that stops after `NMS_KEEP` (10) survivors, instead of the model's per-box Python loop that synchronised with the GPU on every step. The Detector has an **input size** setting (`detector.size` in the vision settings: 768 = the model's own size, default, or 512; `vision_settings.INPUT_SIZES`; it is part of `detection_signature` only when it is not 768, so old detections stay valid) that scales the pictures before detecting: 512 is about 2.3x faster than 768 with less exact boxes (mean IoU with a planted object 0.74 against 0.92; the object was still found on every synthetic frame). Measured with `app/backend/benchmark_detector.py` (synthetic 250 x 250 frames, 3 exemplars, RX 7800 XT, ROCm, 64 frames): original code 3.1 frames/s, now 37 at 768 (same top-2 boxes as the original) and 85 at 512. `HALF = True` runs the model in half precision on a GPU (65 and 141 frames/s) but changes which boxes win on some frames (80% identical top-2 at 768), so it is off by default; batching alone added nothing measurable on this card, stored boxes with human review, and the per-frame mask offsets derived from them. Remaining work in `plans/detector-masking-plan.md` (Phase 4)

### API (`app/backend/api/`)

One thin router per area, each delegating to the domain modules above:
`cameras` (also `DELETE /cameras/{camera}` with its delete preview), `status`, `versions_api`, `ingest_api`, `frames_api` (frames and thumbnails),
`roi_api` (also the product list and product renames), `chain_api` (the Chain canvas and its layout), `classify_api` (also the whole-camera file-name search of the grid, `unmute`, live counts), `insights_api`, `dedup_api` (also `scatter/cached`), `overview_api` (all cameras with reference frame and ROIs for the Overview page), `outliers_api`, `similar_api`, `config_api` (active scoring methods), `rules_api`, `motion_api`, `vision_api` (filter catalogue, per-feature filter/mask/detector settings, live preview, detection job and review).

### Frontend (`app/frontend/src/`)

- `App.tsx` — top bar (title, the four sections, camera, product, hardware badge, version and ⚙️) with a second-level tool bar for sections that hold several pages and routes; `lastSession.ts` — what the browser remembers
- `SidePanel.tsx` (options panel, `PanelGroup`, `PanelSection`, `PanelPortal`: a view writes its controls into the panel), `RankContext.ts` + `RankSelect.tsx` (the top bar's *Rank using*), `CameraDelete.tsx` (delete a camera), `InfoTip.tsx`, `ProductSelect.tsx`, `WheelRange.tsx` (slider that answers the wheel), `HardwareBadge.tsx`, `StepBar.tsx`
- `api.ts` — typed API client
- `views/` — Overview, Chain, Status, Ingest, Dedup, ROI editor, Detector, Edge angle, Classify, Insights, Verdict, Augmentation, Versions (grouped into sections in `views.ts`)
- `classify/` — `PictureGrid` (shared paged card grid + viewer), card, bulk, clear-labels, auto-assign, suggested-goldens panels, SVG scatter (drag a rectangle to zoom and list the frames inside, optionally delete them with a note, or label them all as one of the feature's classes with the "Label N as <class>" buttons, which overwrite existing labels and keep goldens in step; right-click resets), per-day Deleted view (follows the Classify per-page / column setting and pages through the days, newest first; v1.29.1), `FrameViewer.tsx` (full-size picture overlay), cluster browser (row of cluster tabs, paged card grid per cluster with its own grid size per ROI; cards can be labeled, made golden, made representative or deleted, with the same hover keys as Classify, plus Delete)
- `chain/chainModel.ts` + `views/ChainView.tsx` — the Chain canvas (React Flow, `@xyflow/react`); `classify/` also holds `ClassifyKpis` (the clickable numbers), `ClassifyScatter` / `ClassifyOutliers` (the Scatter and Outliers views of Classify) over the shared `ScatterWorkbench` (map, projection job, selection) and `OutlierPanel`, `useDedupState` (embedding choice), `SearchExtras` (the viewer's Product row, Show again and the zoom-line note), `ProductNamesEditor` (rename products), `CardGrid` (also the pager's file-name search), `toolInfo`, `paint` / `painter` / `useGridCard` (sweeps)
- `RoiCanvas.tsx` + `roiGeometry.ts` — pointer-driven ROI draw/move/resize in normalised coordinates
- `views/ConfigurationView.tsx` (method checkboxes), `methodTags.ts` (CPU/R18/R50), `views.ts` (menu icons, `SECTIONS` = Overview (Overview, Status), Management (Ingest), Manipulation (Dedup, ROI editor, Detector, Edge angle, Classify, Insights, Verdict, Augmentation), Export (Versions); `CONFIG_VIEW` is the ⚙️ button at the right of the top bar)
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

- **Template matching** (default since v1.47.0) assumes a fixed camera and an object of constant size and appearance: it copes with small light changes but not with a rotated, scaled or differently seen object. It was checked on shifted photographs and synthetic frames only, **not on the real cameras**.
- The **model** (OWL-ViT) path has been run on real frames once (275 frames, none below a 50% threshold). Its confidence is relative to each frame's best box and not calibrated, and its boxes are often much bigger than the object (the stored box now takes the exemplar's size, centred where the model put its own box, which fixes the size but not a wrong position). On shifted photographs it found the object in 0-100% of the copies depending on the picture. Check boxes in the review with *Show: All frames*.
- The mask follows the detected object by translation only; rotation and scale changes are not followed.
- Detection uses the saved settings, not unsaved edits (Run saves them first), and runs on the filtered crops of the frames and the exemplars.
- Half precision (`HALF`) is off because it changed which boxes win; the 512 input size is less exact than 768; neither was judged on real frames.

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

00. **Chain measurement work, open items (2026-10-19; session notes `memory/2026-10-19-chain-crop-ingest-detector-session.md` and `memory/2026-10-20-chain-lines-and-points-session.md`):** check the two-hole chain (detector, cascaded detector, Calculate, Evaluation) on the real pictures (angle precision, 175 +- 3 deg); a **reference point per detector target** (the found position is the centre of the drawn example box, so "hole plus geometry" is off the hole); a **"no anchor" badge and filter** on the Classify cards for pictures without a detector box; **tags on pictures** and the Ingest date filter (design open); a **warning for mixed picture resolutions** in one camera; straightening a turned part; dots onto a Crop; the Calculate page's geometry for points of two detectors; a Crop fed by an ROI or detector; a detector behind an ROI / Classify with an OK / NG class filter (kept open on purpose). Two flaky tests fail under load but pass alone (`ClassifyView.test.tsx` deleted card, `test_clean_schema.py` parallel first connects).

0a. **Easy access to hidden and deleted pictures** (noted 2026-10-18): the Classify numbers now leave out deleted and muted pictures so the user works only with valid ones, but the user must keep full control of the dataset. Add one obvious place (a view on the Overview or Status page, or a small section per camera) that lists the deleted pictures (with note, time, Restore) and the muted ones per ROI (with Unmute), and shows their counts. Today deleted ones are in Classify's *Show: Deleted*, muted ones behind its *Show muted* checkbox, and either can be found by the file-name search.

0b. **Per-product outlier scoring** (proposed 2026-10-18, not built): in the Outliers view of Classify add a *Pictures* choice (All, Labeled <class>, Unlabeled) so the k nearest neighbours are searched inside one product (or OK / NG) only; the list says "Outliers among <group>, N pictures", a group too small for k says so, and the Dedup Outliers page stays on All. Needs a small backend change in `outliers.py` / `dedup_api`.

0. **Chain canvas, next steps** (`plans/chain-canvas.md`): look at the Chain page in a browser (v1.51.0-v1.57.1 were tested with a mocked API and unit tests, not clicked through), then the open items of `plans/chain-next-steps.md` (Tolerance band dragging, detector-anchored ROI); **Merge box** for A/B branches (late stage: it joins variants such as two ROIs or detectors and must never blend classical and ResNet scores); a "run the whole chain" button; the Overview rework.

1. **Look at the UI restructure, the Detector rework and everything since in a browser on real data** (v1.31.0-v1.63.2, the second half of which — the Chain page, camera delete, the Classify options panel, numbers, search, X / Delete sweeps, product rename, Rank using in the top bar — has only been tested with a mocked API; v1.31.0-v1.50.0: top bar and tool bar, status bar, tool icons, Scatter / Clusters / Outliers as tools, the shared picture viewer and card grids with painting, the Detector's method choice, the review grid with delete, undo, filter and sort) and judge it; run detection again (the default method is now template matching, so earlier detections are stale) and compare the boxes with the 768 / 512 model sizes if you keep the model. Then: choose the hardware badge look, roll the options-panel layout out to the other tools, convert their explanatory text to info tips, and decide on the parked items from `discussions/picture-sorter-ui-navigation-handover.md` (background precompute of scatter and clustering with a "ready / needs refresh" indicator, the status bar's frame position, final names for Management and Manipulation, the Detector page's remaining steps). Possible follow-up: do not drop the scatter / cluster / result caches on every accepted box when the mask is off (`vision_settings.purge_derived`).
2. **Try the 2026-10-15 tools on real data** (nothing in v1.15.0-v1.20.0 has been used on the real cameras or in a browser): Overview stage chips and the step bar, Outliers, Find similar, the edge-angle rule (angle, band width), augmentation ranges (the "not measured" counts), the downstream results form. See `memory/handover-new-tools.md`.
3. Find out which quality metrics the downstream system reports, then refine the Downstream results form (today: free-text metric names).
4. Add focused automated tests for product-scope, version, and export invariants.
5. Measure and normalize classical metric scales per representative ROI.
6. Add coverage-aware or farthest-point selection to reduce candidate redundancy.
7. Consider aligned difference views or heatmaps for faster human verification.
8. Improve per-product grouping in Status and Versions.
9. Add browser-level (end-to-end) tests for the React views; current frontend tests mock the API and cannot exercise real pointer interaction.
10. Build the `setup_torch.sh` / `setup_torch.ps1` hardware detect-or-ask helper; investigate the flaky `test_clean_schema.py::MigrationV3ToV4Tests::test_parallel_first_connects_all_succeed` ("database is locked", seen again 2026-10-18) and the occasional `DedupView.test.tsx` clustering test that fails once under the full-suite load and passes alone. See `memory/gpu-backends-rocm.md`.

Deferred (discussed, not planned): **undo of a whole sweep** (a card deleted by a sweep has Restore on it, which does not bring its labels back; a stroke-level undo with Z was proposed and not built), **frontend bundle size** (v1.51.0: 680 kB, 210 kB gzipped, so `vite build` warns above 500 kB; the Chain canvas library is most of the growth; options: raise `build.chunkSizeWarningLimit`, or load `ChainView` lazily with a dynamic `import()`; to discuss), embedding drift over time (filenames carry `dd.mm.yyyy_hh.mm.ss`), reorganizing the menu into tabs or branches, further rule-based tools (object counting, presence in a zone, colour threshold, blob area).

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
