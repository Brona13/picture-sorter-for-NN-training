---
name: classify-ui-tune
description: Small usability improvements for class selection, pagination, layout, and scoring defaults
status: shipped
document_type: plan
last_updated: 2026-07-29
---

# Plan: Classify view — small UX tunes (deselect, pagination, method default)

> **Status — shipped & verified (2026-07-29).** Bundles four small changes to the Classify view that came out of a seven-topic review. Kept as one plan because each fix is < 30 LOC and they all live in `scripts/view_classify/`.

## Context

Before this pass the Classify view had four friction points the user hit every session:

1. **Cannot deselect a class.** Once a frame was labelled, clicking the same class button was a no-op. There was no way to return a frame to the unlabelled state from the grid, even though `labels.clear_label` already existed.
2. **Pagination only on top; no First/Last.** With 100–1000 frames per batch the grid needed the pagination bar mirrored below the grid and jump-to-end buttons for long batches.
3. **CPU was the default `Rank using` method.** But the user's real-data findings ([findings-real-data-method-comparison.md](../memory/findings-real-data-method-comparison.md)) had already shown CPU and ResNet only agree on 4/10 top-10; CPU's value is disagreement (fed to the "Methods disagree" filter), not accuracy.
4. **Pagination + settings sat on two rows** — settings row on top, pagination row below it, then the grid, then a second pagination row. Two rows of chrome above the grid felt visually heavy and didn't align with the grid edges.

## Changes

All in `scripts/view_classify/`.

### 1. Deselect toggle — `_grid.py::_buttons`

Reuse `labels.clear_label(camera, feature, frame)` (already at [labels.py:75](../scripts/labels.py:75)). When the clicked class equals the current label:

- Call `clear_label`.
- If the frame is also starred for that class (`golden_now == cls`), call `unmark_golden` — a golden without a label would be inconsistent; the existing rule *"star follows the label"* already enforces this direction.

The active class button gets `help="Click again to remove the label."` so the toggle is discoverable. The `else` branch (labelling a new class + moving the star) stays exactly as it was.

### 2. Pagination — First/Last + duplicate bar

Refactor `render_grid`'s inline pagination into a helper called twice (`position="top"` / `position="bottom"`). Ordering left to right: `« First`, `‹ Prev`, `Page x of y · frames a–b of N`, `Next ›`, `Last »`. Widget keys suffixed by `position` to satisfy Streamlit's global-uniqueness rule.

`First` sets `st.session_state[page_key] = 1`; `Last` sets it to `n_pages`; both disabled at their ends. Keep the `min(page, n_pages)` clamp for shrinking result sets.

### 3. Rank method default — resnet50

In `_controls.py::render_controls`, add:

```python
rank_default = methods.index("resnet50") if "resnet50" in methods else 0
rank_method = f2.selectbox("Rank using", methods, index=rank_default, disabled=not scored)
```

`methods_available()` in [classify.py:63](../scripts/classify.py:63) still returns `["cpu", "resnet18", "resnet50"]` — cpu remains selectable, the "Methods disagree" filter still consumes it. Only the default index changes.

### 4. One-line control row (Option A) — `_grid.py::_control_row`

Consolidate the settings row and both pagination rows into a single `_control_row(...)` helper called twice from `render_grid`. Layout in one `st.columns` call:

- Pagination (weights ≈ 8.8, left ~2/3): `First / Prev / status / Next / Last`.
- Gap column (0.4).
- Settings (weights ≈ 4.8, right ~1/3): `Per page` label + dropdown + `Columns` label + dropdown; selectboxes use `label_visibility="collapsed"` with inline markdown labels so they sit level with the buttons on the left.

Both bars mirror each other. Since Streamlit widget keys must be unique, top and bottom widgets carry `::top` / `::bottom` suffixes, but they read from and write back to a single shared session-state key (`perpage::{camera}::{feature}` and `cols::{camera}::{feature}`). The pattern:

- Before either bar renders, `setdefault` the shared key from the persisted DB value; then mirror the shared value into each widget's own key.
- Each dropdown carries `on_change=partial(_sync_setting, camera, feature, kind, shared_key, position)` that copies the changed widget's value back into the shared key and persists to the DB.

## Files touched

- `scripts/view_classify/_grid.py` — `_buttons` (change 1), `render_grid` restructure + new `_control_row` + `_sync_setting` (changes 2 & 4).
- `scripts/view_classify/_controls.py` — one-line default-index change (change 3).

## Verification

Manual, in `streamlit run scripts/app.py`:

1. Deselect: label a frame OK → count +1 → click OK again → count -1, star (if present) removed.
2. Pagination: top + bottom bars both render; « First disabled on page 1; Last » disabled on last page; jumps work from either bar; no widget-key collision in the console.
3. Rank method: fresh session → `Rank using` shows `resnet50`; caption reads *"…under resnet50 — longest bar = nearest class…"*. CPU still selectable in dropdown.
4. Control row: both bars sit on a single line each; buttons left ~2/3, settings right ~1/3; left/right edges align with the grid below.
5. Sync test: change `Per page` in bottom bar → top updates on the next rerun (fast enough to feel instant).

## Out of scope

- No changes to `render.py`, `_bulk.py`, `_auto.py`, `_helpers.py`, `db.py`, or `labels.py`.
- No change to the star / golden semantics beyond the deselect + unstar tie-in.
- No change to which methods are computed (all three still run on every Refresh).
