---
name: auto-assign-by-leaning
description: Auto-assign unlabelled frames according to their strongest scoring-method leaning
status: shipped
document_type: plan
last_updated: 2026-07-29
---

# Plan: Auto-assign unlabelled frames by leaning

> **Status — shipped & verified (2026-07-29).** New panel in Classify; existing bulk-label panel untouched.

## Context

For stage-1 product sorting the user needs *every* frame assigned to a product before quality classification can proceed. Their real-data tests showed ResNet50 correctly identifies products once a good golden set exists. The existing bulk-label panel (`_bulk.py`) targets one class at a time ("label all these frames OK"), which doesn't match this workflow — the user wants a single action that fills every unlabelled frame with *its own* leaning.

Intended outcome: pick which classes to include, set a confidence floor, preview the per-class breakdown, hit Confirm — every matching unlabelled frame gets labelled with its own leaning under the currently selected `Rank using` method (default ResNet50).

Two-step preview-then-confirm is deliberate: matches the user's quality-conscious working style. Nothing is written until they confirm.

## Approach

New `scripts/view_classify/_auto.py` — a new panel rendered by `render.py` in the same slot as the existing `_bulk.render_bulk`. Kept as its own file because the intent is different from bulk-label (single-class targeted vs multi-class auto-fill), and mixing the two would make either harder to reason about.

Filter:

- Frame not in `lab` (unlabelled).
- Frame not in golden set (not a reference).
- `rank_method in fs.per_method` and both `.leaning` and `.margin` are non-None (i.e. at least two classes have goldens under this method).

Panel contents (inside a `st.expander("Auto-assign by leaning (N unlabelled candidates)")`):

1. `st.multiselect` "Include only these classes" — defaults to all classes. Lets the user exclude classes they haven't marked enough goldens for yet.
2. `st.slider` "Minimum confidence (margin between top two classes)" — from `min(margin)` to `max(margin)` over candidates. Bounds computed live so the slider fits the data.
3. Preview: `Preview — N frame(s) will be labelled:` header + per-class bullet list `` - `cls` — **k** frames · avg margin 0.xxxx``.
4. `st.button("✅ Confirm auto-assignment of N frame(s)", type="primary", disabled=total==0)`. On click, for each class with picks, `labels.set_labels_bulk(camera, feature, frames, cls, source="auto")`. `source="auto"` tags the labels in history so they're distinguishable from `"manual"` / `"bulk"`.

Widget keys carry `f"::{camera}::{feature}"` suffixes so switching ROIs doesn't leak state.

## Files touched

- New: `scripts/view_classify/_auto.py`.
- `scripts/view_classify/render.py` — two edits: import `_auto`, and add `_auto.render_auto(items, camera=..., feature=..., classes=..., rank_method=..., scored=..., lab=..., gold=...)` after the existing `_bulk.render_bulk(...)` call.

## Verification

Manual, in `streamlit run scripts/app.py` on `pekat-cam3 › suspension-rod-front-left`:

1. Open Classify, Refresh scores. Expand `Auto-assign by leaning (N unlabelled candidates)`.
2. Multiselect shows `OK` and `NG` chips (both selected by default).
3. Slider spans the actual margin range of candidates.
4. Preview updates live: `OK — k frames · avg margin 0.xxxx`, `NG — k frames · avg margin 0.xxxx`.
5. Confirm button label reads `✅ Confirm auto-assignment of N frame(s)` and is disabled iff N == 0.
6. Not clicking Confirm leaves the data unchanged (verified: labelled counts unchanged after opening + closing the panel).

Verified live: on suspension-rod-front-left at 0-margin threshold, `267 unlabelled candidates` → preview `OK 94 · avg 0.0042`, `NG 173 · avg 0.0067`. Confirm button enabled at count 267. (Did not click Confirm during verification — that's the user's decision to make deliberately.)

## Design decisions

- **Uses the current `rank_method`** — so the user chooses the method via the existing `Rank using` selectbox above, not a separate dropdown here. Keeps the panel focused.
- **`source="auto"`** in `set_labels_bulk` — makes the history distinguishable. Since `labels` is append-only, we retain the ability to filter out auto-labels later if the model turns out wrong on some subset.
- **No undo built into the panel** — but the deselect-toggle change (see [classify-ui-tune.md](classify-ui-tune.md)) means the user can click any auto-labelled frame's class button to clear it manually.
- **No prompt on Confirm** — the preview + explicit Confirm button already give a two-step gate; a modal would be UX overkill.

## Out of scope

- Bulk-unlabel (undoing an auto-assign en masse). If the user finds themselves needing this after real use, add it as a follow-up.
- Cross-method consensus filter (only auto-assign frames where cpu+resnet18+resnet50 all agree). Same — add if the disagreement rate turns out to matter for auto-fill quality.
- Any changes to `_bulk.py` (the existing single-class bulk-label stays exactly as it was).
