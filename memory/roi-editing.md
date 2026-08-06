---
name: roi-editing
session_date: 2026-07-28
last_updated: 2026-07-28
description: ROI rectangles can be moved/resized with canvas handles — how it works and why moving one is risky for existing labels
metadata:
  type: project
---

The ROI editor gained a **Move & resize** mode (2026-07-28), so an existing rectangle can be adjusted instead of redrawn from scratch. Plan: `plans/roi-editing.md`. Extends [[multi-product-hierarchy]].

**How it works.** `streamlit-drawable-canvas` (already installed) supports `drawing_mode="transform"` (fabric.js selection + scale handles) and `initial_drawing` (shapes as editable objects) — **no new dependency**. A mode radio switches between *Draw a new ROI* (unchanged) and *Move & resize an existing ROI*.

**Key design points:**
- **One ROI at a time**, picked from a dropdown, so it saves back **by name**. The canvas gives objects no identity, so matching several boxes back to names would rely on array order — too fragile. The other ROIs stay baked into the background as named green context (`_golden_with_rois(..., skip=<target>)` avoids drawing the target twice).
- **`initial_drawing` is seeded from the ROI's *saved* geometry**, which doesn't change while dragging — so the component isn't re-initialized on the rerun each mouse-up triggers and the box **doesn't snap back**. This was the main risk; it did not materialize.
- **Numeric x/y/w/h fields** alongside the canvas. They re-seed when the canvas reports a new box by putting the box in the **widget key** (`f"ex::{name}::{nonce}"`) — changing the key rebuilds the widget so it takes the new value, while typed values persist as long as the canvas is idle. They're also the whole UI when the canvas is unavailable.
- Shared geometry helpers live in `ui_common`: `fabric_rect()` and `box_from_object()` (which handles `scaleX`/`scaleY` — resizing with handles *scales* the object rather than changing width/height) so the draw and edit paths can't drift.

**⚠️ Moving a ROI does not invalidate its labels.** Labels and goldens are keyed by **feature name**, not geometry, so they survive a move — but they were judged on the *old* crop. The editor therefore warns when the target already has labels/goldens, naming the counts, and does **not** auto-clear them. The score cache *is* keyed by the rounded box (`classify._roi_cache_key`), so it invalidates itself automatically (old rows are orphaned but harmless) — re-run **Refresh scores** after a move.

**Verified:** geometry round-trip (ROI → fabric → box exact), handle-resize via scaleX/scaleY, off-canvas clamping; live drag with no snap-back; the warning firing on a real 22-label ROI; and headless save semantics (geometry changes while `role`/`classes`/`products`, labels and goldens are preserved). Draw-new mode unchanged.
