---
name: insights-view
description: Insights view with per-method confusion matrices for labelled frames
status: shipped
document_type: plan
last_updated: 2026-07-29
---

# Plan: Insights view — per-method confusion matrices

> **Status — shipped & verified (2026-07-29).** New read-only view; no changes to existing views.

## Context

The user's real-data testing showed ResNet50 is highly reliable at product classification once a good golden set exists. To *quantify* how each scoring method actually agrees with the user's labels — and where it disagrees — they wanted a confusion matrix. Since the disagreement between methods is one of the two highest-value review levers (see [findings-real-data-method-comparison.md](../memory/findings-real-data-method-comparison.md)), showing all three methods side-by-side is the natural starting point.

Chosen scope (Option 1 from a widget mock in the design session): **one matrix per method, binary or NxN depending on the feature's classes.** No cross-method aggregation. Option 3 (full multi-class products matrix alongside a binary OK/NG matrix) is a later possibility if this proves too limited.

Intended outcome: a new sidebar view that, for a selected feature, computes each method's leaning for every held-out labelled frame and shows an N × N confusion matrix with per-method accuracy underneath.

## Approach

New `scripts/view_insights.py` following the pattern of `view_status.py` — a single `render(camera, product)` function invoked from `app.py`'s dispatch. Reuses:

- `datamodel.list_features_for` / `datamodel.compose_feature` / `datamodel.classes_for` — feature picking + class vocabulary.
- `labels.current_goldens` / `labels.current_labels` — ground truth.
- `classify.refresh` + `classify.methods_available` — scoring (with the existing per-frame vector cache).
- `ui_common.feature_label` — the feature dropdown formatter.

Held-out set = labelled frames minus golden frames. Goldens are the reference set; scoring a golden against itself would be meaningless ("this 2x4 reference leans 4x4RS"). Accuracy is measured on the non-golden labelled subset.

Guardrails on entry:

- < 2 classes have goldens → matrix requires at least two reference sides for leaning to exist; show an info hint pointing to Classify.
- Zero held-out labelled frames → show an info hint saying every label is currently a golden.

Otherwise: `🔄 Compute matrices` button drives `classify.refresh(...)` with the existing progress-bar callback, then per method:

- Build `{true_class: {pred_class: count}}` from held-out frames whose per_method leaning is non-None.
- Render as a compact HTML table: green fill for the diagonal (matches), red for off-diagonal (misses), transparent for zero cells.
- Caption below shows accuracy % and correct / total, plus a "N unscored" note if some held-out frames had no leaning under that method.

## Files touched

- New: `scripts/view_insights.py` — the whole view.
- `scripts/app.py` — three small edits: `import view_insights`, add `"Insights"` to the sidebar radio list, add `"Insights": view_insights.render` to the `_VIEWS` dispatch dict.

## Verification

Manual, in `streamlit run scripts/app.py`:

1. Open Insights on `pekat-cam3 › suspension-rod-front-left`. Click `Compute matrices`.
2. Three matrices render side-by-side (cpu / resnet18 / resnet50). Diagonal cells green, off-diagonal red, zero cells transparent.
3. Accuracy line under each matrix reads `Accuracy X.X% (n/total)`.
4. Held-out count in caption matches labelled-minus-golden count.
5. Cold state: feature with <2 golden classes → shows the "needs goldens in at least two classes" hint, no matrix.

Verified during implementation:
- 14 held-out frames on suspension-rod-front-left produced cpu 42.9% (6/14), resnet18 50.0% (7/14), resnet50 42.9% (6/14) — small NG subset (3 held-out NGs) makes accuracy noisy; the shape of the miss pattern (all three over-predict NG on real-OK) is the useful signal and matches the near-duplicate finding.

## Design decisions

- **Separate `Compute matrices` button** rather than auto-run. Same rationale as the Classify view: user is in control of when scoring runs. Later could hydrate from `results_cache` (see [persistent-scored-results.md](persistent-scored-results.md)) but not part of this plan.
- **Own session-state key** (`insights::{camera}::{feature}`) rather than reusing Classify's `classify::{camera}::{feature}`. Keeps the two views decoupled; a tiny recompute cost is acceptable since the underlying `score_cache` still hits.
- **HTML table via `st.markdown(unsafe_allow_html=True)`** rather than a chart library. Content is tiny, headers are the class names, colours encode diagonal vs off-diagonal — nothing a table can't do.
- **Colours are hard-coded** (green C0DD97 / red F7C1C1 from the visualize palette) because Streamlit's CSS variables aren't stable across themes and matrix cell semantics are universal.

## Out of scope

- Option 3 (full multi-class matrix + separate binary OK/NG matrix). Deferred until Option 1 proves too limited.
- Any change to Classify view or to `classify.py` scoring itself.
- Cross-method statistics (agreement rate, disagreement breakdown by class) — could be added later in the same view.
