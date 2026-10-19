---
name: crop-box
description: A Crop box on the Chain: one fixed rectangle cuts every picture before it goes on to the next box (first picture-manipulating step); detectors read the cropped picture
status: built as v1.69.0 (approved by the user 2026-10-19); open items at the end
document_type: plan
last_updated: 2026-10-19
---

# Crop box

## Why
The user wants to cut the picture to a fixed rectangle and run a detector on that, without using an ROI for it: keep the simple picture steps apart from the measuring tools (ROI = labelling unit, detector = measuring tool, Crop = picture manipulation). Source frames stay untouched.

## Decisions (with the user, 2026-10-19)
- A new Chain box, **Crop** (name provisional; the internal kind is `crop`). Room is left for more picture manipulations later (resize, rotate, filter), but **only Crop is built now**. Resizing is understood as "the picture is smaller because it is cut"; a real resize is a possible later function or parameter.
- **One input, one output.** The output is a picture: the input picture cut to the rectangle. Nothing is written to disk; the cut is computed when needed.
- **Rectangle stored as fractions** of the input picture (like an ROI), the same for every picture. A box with no rectangle drawn passes the picture on unchanged.
- **Own page** built from what exists: the ROI editor's canvas (`RoiCanvas` on `ZoomPane`: wheel zoom, pan, Reset, 1:1), the frame picker, draw / move / resize with handles, **saved automatically when the pointer is released**.
- **Inputs now:** Ingest or another Crop (both give a whole picture). **Outputs now:** a detector (it then works on the cropped picture) or another Crop. Crop fed by an ROI or by a detector, and detector behind an ROI/Classify, are **left open on purpose** (discussed later).
- **Coordinates:** a detector behind a Crop works in the cropped picture's pixels (examples, found boxes, human boxes). Angles are unaffected; distances stay in the same pixel scale because a crop does not scale. An ROI anchored to such a detector adds the crop's offset back, so the ROI still lies on the full picture.
- Detector results go stale when a Crop above them changes (the crop is part of the detector's signature).

## Side note to keep (not built): resolution warning
If one dataset (camera) holds pictures of different resolutions, some measurements and crops behave differently (fractions give different pixel sizes; pixel-based thresholds and example sizes do not carry over). The app should warn about it somewhere, for instance on Ingest / Overview and on the Crop page. Parked in `docs/current-project.md` open work.

## Steps
1. Backend `flow.py`: kind `crop` (prefix `crop`); arrows ingest/crop -> crop, crop -> detector; one input per box; `input_rects`, `apply_rects`, `rect_offset`; `update_node` accepts `rect`; node detail; examples cut on the cropped picture; detector run reads the cropped picture; signature includes the rects; deleting or disconnecting a Crop reconnects its followers to Ingest.
2. API: `GET /flow/nodes/{id}/picture?frame=&stage=input|output&size=` returns the picture a box works on (or, for a Crop, its output).
3. `anchor.py`: add the crop offset to detector boxes.
4. `chain.py`: Crop boxes on the canvas (summary, default name, column).
5. Frontend: palette **+ Crop**, `chainModel` arrow rules, Crop page (`FlowBoxView`: frame picker + `RoiCanvas`, auto-save on release, clear crop), panel section, detector page reads `.../picture` when cropped.
6. Tests (backend: crop maths and offsets, detector on a cropped picture finds the same part at the shifted place, anchor offset, arrows, delete; frontend: arrow rules, page draws and saves on release, detector uses the cropped picture URL), docs, version bump.

## Open / later
Crop fed by an ROI or a detector; a real resize function; resolution-mix warning; whether the Crop output should be previewable on the Classify grid.
