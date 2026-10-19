---
name: chain-crop-ingest-detector-session
description: Session 2026-10-19 (v1.66.5 to v1.73.0) on the Linux machine after the Windows work - anchored ROI and detector dots, Evaluation box, Crop box, Ingest page, detector page canvas, Calculate geometry, cascade target names; decisions, rules, open items
status: current
document_type: memory
session_date: 2026-10-19
---

# Session 2026-10-19: Chain measurement boxes, Crop, Ingest, detector pages (v1.66.5 to v1.73.0)

Started by pulling the Windows work (v1.63.3 to v1.66.4: detector, Calculate, Tolerance boxes, rotation-aware search) and the user's handover `discussions/modules-chaining-canvas.md`. Everything below is committed and pushed (`origin/main` = `fa8d8a1` for the code, earlier `a123501`, `67e1cec`; a docs-and-memory commit saves this session). Plans written this session: `plans/chain-next-steps.md`, `crop-box.md`, `detector-to-roi.md`, `cascade-targets.md`.

## What was built, by version

| Version | What |
|---|---|
| 1.66.5 / 1.66.6 | Chain arrows are `smoothstep`; the nominal +- tolerance band on the histogram is draggable |
| 1.67.0 | **Anchored ROI** (`anchor.py`): an ROI follows a detector box per picture; pictures without a box have no ROI (no fallback to the static rectangle) |
| 1.68.0 | **Tolerance renamed Evaluation** (kind `evaluation`, ids `eval:N`, old graphs and layout migrate once); its page uses the card grid (`views/ValueGrid.tsx`); histogram can be hidden and zoomed (drag = zoom the x axis and narrow the grid, right-click restores) |
| 1.69.0 | **Crop box**: one fixed rectangle (fractions) cuts every picture; page on `RoiCanvas`/`ZoomPane`, saved on release; detectors behind it work in the cut-out's pixels; anchors add the crop offset back |
| 1.70.0 / 1.70.1 | **Ingest page** reorganised (add pictures, ingested pictures as a grid with ingest date, date filter, order, maintenance); catalog rebuild keeps ingest times; Back to chain when opened from the Chain |
| 1.71.0 | A **dot per detector target**; dragging it onto an ROI feature anchors the ROI. Modes: the found box plus margin (default) or my own rectangle (offset read live from the ROI's rectangle; the ROI editor opens on the example picture with the found box outlined) |
| 1.71.1 | Detector page offset fixed: `.flow-stage` was wider than the picture, so the overlay mapped the pointer wrongly |
| 1.71.2 | Detector page uses the shared `ZoomPane` (wheel zoom, pan, Reset, 1:1, size slider) and the ROI editor's rectangle look |
| 1.72.0 | Calculate / Evaluation viewer draws the geometry behind each number (`CalcGeometry.tsx`, `calcGeometry.ts`) |
| 1.72.1 | A found position is a pixel index; everything that draws or cuts adds half a pixel (`pixelCentre.ts`, `anchor._on_frame`) |
| 1.73.0 | A **cascaded detector has its own target names**, each with an `inside` link to a target of the input detector |

## Decisions and rules worth keeping
- **A found position is the centre of the example box that was drawn**, not of what is inside it. "Hole plus its neighbouring geometry" is found with its centre between the two; the hole's own centre needs a second detector inside the box (or a reference point per target, not built).
- ROI behind detector: one anchor per ROI; two targets = two ROIs, each with its own Classify box. A turned part is not straightened.
- Crop is a picture step, not an ROI; it writes nothing to disk. Detector results go stale when a Crop above changes (the crops are in the signature).
- Settings keys: `flow.graph` (boxes, arrows), `roi.anchor.<feature>`, `chain.canvas`; no schema change (still v8).
- Verify UI/layout bugs in a real browser (see the feedback memory): two detector-page bugs were invisible to jsdom tests.

## Open / not built
- "No anchor" badge and filter on the Classify cards (blank thumbnails for pictures without a box); reference point per target; straightening a turned part; dots onto Calculate or a Crop; a Crop fed by an ROI or a detector; a detector behind an ROI / Classify with an OK / NG class filter (kept open on purpose); a real resize and other picture steps.
- **Resolution warning** for one dataset with mixed picture sizes (parked by the user).
- **Tags on pictures** (free text, like the camera tags; date filter on Ingest is where they sit); whether they share the camera tags' vocabulary is undecided.
- Nothing has been calibrated on real frames (angle precision of the two-hole chain, 175 +- 3 deg).
- Flaky tests under load, not caused by this work: `ClassifyView.test.tsx` "a deleted card fades" and `test_clean_schema.py` parallel first connects; both pass alone.
