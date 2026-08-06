---
name: package-layout
session_date: 2026-07-28
last_updated: 2026-07-28
description: The two big view files (view_classify, view_roi_editor) are now packages — where each concern lives
metadata:
  type: reference
---

The two largest view files were split into packages on 2026-07-28 to cut per-edit token cost (both had grown past 460 lines with monolithic `render()` functions). Structure is intentionally
parallel between the two so the next new view can copy it.

## `scripts/view_classify/`

```
__init__.py    – re-exports render (so `import view_classify` still works from app.py)
_styles.py     – OK_TINT_JS  (the ~50-line HTML/JS blob that tints active OK buttons green)
_helpers.py    – scored_key, golden_signature, leaning_html
_controls.py   – render_controls (Show / Rank / Order) + filter_and_sort
_bulk.py       – render_bulk (bulk-label expander)
_grid.py       – render_grid: pagination + per-card grid; _card and _buttons inside
render.py      – orchestrator: header, feature picker, metrics, refresh, dispatch
```

## `scripts/view_roi_editor/`

```
__init__.py    – re-exports render
_canvas.py     – image_to_url shim + HAS_CANVAS/st_canvas import + golden_with_rois()
_styles.py     – MULTISELECT_CHIPS_CSS
_headline.py   – _chip + roi_headline (HTML for a Defined-ROIs card headline)
_draw.py       – render_draw_new (the "Draw a new ROI" mode)
_edit.py       – render_edit  (the "Move & resize an existing ROI" mode)
_roi_list.py   – render_defined_rois + render_products_editor + _save_products callback
render.py      – orchestrator: scope caption, frame picker, mode radio, dispatch
```

**Rules for anyone editing these:**
- `render.py` orchestrates; per-concern code lives in `_*.py` submodules.
- `_styles.py` holds any HTML/CSS/JS constants — so an unrelated edit doesn't re-encode them every Read.
- Public entry point is always `render(camera, product=None)` re-exported from `__init__.py`; `app.py` and everything else already imports through the package name.
- New submodules are underscore-prefixed and imported with a relative import (`from . import _grid`) — they aren't a public API.

**Token-cost payoff, measured on this session's edits:**
touching one concern (e.g. the button row) now Reads a ~180-line file instead of the 462/611 line monolith, and constant HTML/JS blobs (~50 lines each) don't ride along in every Read of nearby code. Follow the same pattern if `view_versions.py` (135 lines) or any other view crosses ~250 lines.
