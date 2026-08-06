---
name: roi-editing
description: Editable ROI rectangles with move and resize handles
status: shipped
document_type: plan
last_updated: 2026-07-28
---

# Plan: Editable ROI rectangles (move & resize with handles)

> **Status (2026-07-28).** ✅ Shipped & verified. The snap-back risk did **not** materialise:
> seeding `initial_drawing` from the *saved* geometry keeps the dict identical across reruns, so a
> dragged box stays put through the mouse-up rerun (measured: x 0.2807 → 0.3110, w/h unchanged).
> `update_streamlit=True` was kept; the documented `update_streamlit=False` + Apply fallback was
> not needed.

## Context

Today the ROI editor can only **draw new** rectangles. Existing ROIs are baked into the background image as green pixels by `_golden_with_rois()` — they are not objects, so the only way to change one is to redraw it freehand from scratch. That is how the two "connector D" ROIs ended up with visibly different geometry for the same feature
(`2x4::…` at `0.816,0.785,0.063,0.076` vs `4x4RS::…` at `0.830,0.726,0.080,0.102`).

The user wants standard manipulation handles: select a rectangle, drag it, resize it.

**Feasible with no new dependency.** The installed `streamlit-drawable-canvas`
(`.venv/Lib/site-packages/streamlit_drawable_canvas/__init__.py`) already supports:
- `drawing_mode="transform"` — "object manipulation" (fabric.js selection + scale handles);
- `initial_drawing: dict` — pre-load shapes as **editable objects** (same shape as `json_data`).

## Decisions (from the user)

- **One ROI at a time.** Pick it from a list; it becomes the editable box. The other ROIs stay drawn in the background as named green context. Saving is by **name**, so no reliance on canvas array order (the canvas gives objects no identity — matching many boxes back to names would be fragile).
- **Numeric x/y/w/h fine-tune fields too**, pre-filled with the current box — for precise nudges, for copying identical geometry between products, and as a guaranteed path if the canvas component ever breaks.

## Approach

**1. Mode selector** in `scripts/view_roi_editor.py`, above the canvas:
`Draw new ROI` (today's behaviour, unchanged) / `Move & resize existing`.

**2. Edit mode**
- Target ROI chosen from the in-scope `rois` list (reuse the existing scope filter and `datamodel.split_feature()` for the short display name).
- Background: `_golden_with_rois()` gains a parameter to **skip the target ROI** when baking, so the box isn't drawn twice (once as pixels, once as an object). Other ROIs keep their green outline + name label for context.
- `initial_drawing = {"version": "4.4.0", "objects": [<one fabric rect>]}`, built from the ROI's normalized box × the existing `disp_w`/`disp_h`.
- `st_canvas(..., drawing_mode="transform", initial_drawing=..., key=f"canvas-edit::{camera}::{frame_name}::{roi_name}")` — a distinct key per mode/target so switching remounts cleanly.
- Read back with the **same conversion already used** in the draw path (`left/disp_w`, `top/disp_h`, `width*scaleX/disp_w`, `height*scaleY/disp_h`, clamped to 0–1). Extract that into a small helper so draw and edit share one implementation.

**3. Numeric fields** — four `st.number_input`s seeded from the canvas box (falling back to the stored box), so dragging then nudging works. These are also the whole UI when `HAS_CANVAS` is False (the existing `_manual_box()` fallback becomes the edit path too).

**4. Save** — write the new geometry through `datamodel.save_rois()`, mutating **only** `x/y/w/h` on the matching `ROI` and preserving `name`, `role`, `classes` and `products`.

## Important: warn before changing a ROI that already has work

Labels and goldens are keyed by **feature name**, not geometry, so they **survive** a move — but they were judgements the user made looking at the *old* crop. The score cache is keyed by the rounded box (`classify._roi_cache_key`), so it invalidates itself automatically (old rows are orphaned but harmless).

So when the target ROI has any labels/goldens, show a warning before saving, naming the counts (reuse `labels.counts()` as the Defined ROIs card already does) and stating that the existing decisions were made on the previous rectangle and should be reviewed. Do **not** auto-clear them.

## Risks to verify while building

- **Snap-back:** `update_streamlit=True` sends data on mouse-up → rerun → if the component re-initialises from `initial_drawing`, the drag could revert. Mitigate by keeping the passed dict byte-identical across reruns (it is derived from *saved* state, which doesn't change while dragging). If that still fights, fall back to `update_streamlit=False` plus an explicit **Apply** button. Verify empirically before declaring it done.
- Canvas width comes from `ui_common.editor_display_width()`, which is already unreliable (open TODO `todo-roi-image-fullwidth`). Coordinates are normalised so correctness is unaffected, but a width change remounts the canvas.
- `.claude/launch.json` sets `--server.fileWatcherType none` → **restart the server** to see code changes (see `memory/streamlit-gotchas.md`).

## Files

- `scripts/view_roi_editor.py` — mode selector, target picker, `initial_drawing`, transform canvas, numeric fields, save handler, `_golden_with_rois()` skip-target parameter.
- `scripts/ui_common.py` — shared `fabric_rect(roi, w, h)` / `box_from_object(obj, w, h)` helpers so the draw and edit paths can't drift.

## Verification

1. Restart the app; ROI editor → **Move & resize** → pick `screw-bottom-1`.
2. Drag and resize it; confirm the box does **not** snap back after each mouse-up.
3. Nudge with the numeric fields; Save; confirm `cameras/pekat-cam3/rois.json` shows the new `x/y/w/h` and that `role`/`classes`/`products` are untouched.
4. Confirm the Defined ROIs card thumbnail re-crops (it is cached on the ROI tuple, so it should change on its own) and the frame counts are unchanged.
5. Pick a ROI **with** labels (e.g. `2x4::product 2x4, connector D`, 8 goldens / 3 labels) and confirm the warning appears and that the labels/goldens still exist afterwards.
6. Re-run **Refresh scores** in Classify for that feature and confirm it rescoring (cache miss on the new box) without errors; check `preview_logs`.
7. Confirm **Draw new ROI** mode still behaves exactly as before.
