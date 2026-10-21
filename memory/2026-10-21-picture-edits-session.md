---
name: 2026-10-21-picture-edits-session
description: Session notes 2026-10-21 - the Picture edits box (v1.82.0), filters, ROI reading a box, Classify viewer switch, scoring speed-up (v1.87.0)
status: historical
document_type: session-notes
last_updated: 2026-10-21
---

# Session 2026-10-21: Picture edits

What was built (all on the work Windows laptop's request; each version has its own commit and patch):

- **v1.82.0** The Chain's Crop box became **Picture edits** (kind and ids stay `crop`, `crop:N`): an ordered list of steps (crop, filter) stored as `steps`; old `rect` nodes read as one crop step. Drag to reorder, live preview with Before/After, filters from the Detector page catalogue. `flow.py`, `views/PictureEdits*.tsx`, `pictureEdits.ts`.
- **v1.83.0** Edge and contrast filters: unsharp mask, edge enhance, Sobel, Canny, Laplacian, morphological gradient, CLAHE.
- **v1.84.0-v1.84.1** An arrow Picture edits -> ROI: the ROI reads the box's output picture (`roi_input.py`, `roi.input.<feature>`); its rectangle is relative to that picture. 1.84.0 allowed filters only; 1.84.1 allows crops and a followed target (pictures without a target have no ROI picture). A bug found by the tests: my cleanup left `save_graph` inside an `if kind == "crop"` in `flow.update_node`.
- **v1.84.2** Scoring no longer computes vectors for soft-deleted pictures.
- **v1.84.3 / v1.85.0 / v1.85.1** The Classify full-size viewer shows the box output for a fed ROI and has one **Original / Filtered** toggle (draft `steps=` without the filter steps).
- **v1.86.0** Grey, threshold (Otsu / fixed / adaptive, Bright/Dark toggle), keep biggest blobs (smallest size as % of the picture), outline of blobs (contour / ellipse / filled ellipse); filters got **choice parameters** (toggle for two options, drop-down for more; `views/FilterParams.tsx`); Sobel got a direction choice.
- **v1.87.0** Faster Classify recalculation: worker threads load, cut and describe the next group while the network runs; CUDA batch 8 -> 32, groups 32 -> 64; parallel preprocessing; channels_last and cudnn benchmark. The work laptop (RTX A2000, 4 GB, torch 2.11.0+cu128) already used CUDA; the 3D graph spikes were the GPU waiting for the CPU. **Not measured and the torch paths were not run in the sandbox.**

Open (also in `docs/current-project.md`, item 000): the **blob detector** (centre, axis angle, size per blob -> Calculate / Evaluation for axis alignment and distance), measuring v1.87.0, a real-browser check of everything above, and the ROI editor for a fed ROI (one chosen picture; other ROIs hidden).

Working notes: Windows delivery is a version-named `git format-patch` plus a frontend dist zip (no npm on the work laptop); he applies with `git am`, restarts the backend and hard-reloads the browser. A stale frontend (old dist) once looked like a missing feature: the version number comes from the backend, so it does not prove the new frontend is loaded.
