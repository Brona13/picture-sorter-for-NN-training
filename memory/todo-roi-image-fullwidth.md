---
name: todo-roi-image-fullwidth
session_date: 2026-07-08
last_updated: 2026-07-24
description: TODO — ROI editor image does not reliably stretch to full browser width
metadata:
  type: project
---

**Open TODO (deferred by user 2026-07-08):** the ROI-definition image is meant to fill the browser width but doesn't stretch fully on the user's real browser. Current approach reads `window.innerWidth` via `streamlit-js-eval` and sizes the canvas to `innerWidth - 380` (capped 1600) — the function is `editor_display_width()` in **`scripts/ui_common.py`** (moved there from `app.py` in the 2026-07-09 refactor; called by `view_roi_editor.py`).

Likely cause: `streamlit_js_eval` runs inside a component iframe, so `window.innerWidth` may report the iframe/container width rather than the true page width. Possible fixes to try later: read `window.top.innerWidth` / `parent` width, or measure the `.block-container` element width, or use a resize-aware component.

User said it's low priority — revisit later. See [[sorting-ux-decisions]].
