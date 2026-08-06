---
name: curation-loop-enhancements
description: Future curation improvements for deduplication, embeddings, comparison, and golden refinement
status: active
document_type: plan
last_updated: 2026-07-30
---

# Plan: Curation-loop enhancements — perceptual dedup, embedding scatter, pair comparator, uncertainty-guided golden refinement

> **Status (2026-07-30).** ✅ **Phases 1, 2, 4 shipped & verified.** Phase 3 (pair comparator) not yet started.
> Drafted from [discussions/image-sorting-tool-handoff.md](../discussions/image-sorting-tool-handoff.md).

## Context

The handoff document describes new curation ideas that steer the tool beyond its current "rank-against-goldens → review grid" loop. This plan reconciles those ideas with the current architecture and turns the *new* parts into concrete, sequenced work.

Everything below respects the existing invariants:

- Source frames stay in `cameras/<camera>/unsorted/`; nothing moves.
- Goldens are labeled frames; classical and ResNet opinions stay independent.
- Labels and goldens are scoped by camera × feature × frame.

## What's already in the project (do not re-implement)

- ResNet18/50 embeddings and classical CPU family, both cached per-frame per-ROI (`scripts/classify.py`, `scripts/embedding.py`).
- Per-class goldens, leaning, margin, novelty (`scripts/labels.py`, `docs/methodology.md`).
- Iterative golden refinement via the Classify view + Refresh.
- Freeze / revert / export via versions (`scripts/versions.py`).
- Content-hash (SHA-256) *exact* duplicate rejection at ingest (`scripts/ingest.py`).
- Auto-assign by leaning already exists as a bulk aid (see [auto-assign-by-leaning.md](auto-assign-by-leaning.md)).

The handoff's "flow sequencing" (goldens, score, review, freeze, export) is the current flow. The new material is what follows.

## What's genuinely new (this plan's scope)

1. **Perceptual near-duplicate dedup** via DBSCAN on ROI-cutout embeddings — beyond exact-hash matching.
2. **2D embedding scatter** (UMAP/t-SNE) for visual sanity-checking of clusters and class separation.
3. **Pair comparator** — pick any two frames, view side-by-side, optionally *blink-compare*.
4. **Uncertainty-guided golden picking** — surface most-ambiguous unlabeled candidates as suggested new goldens, with light diversity to avoid near-identical picks.

Deferred (see end): per-class DBSCAN strictness; interactive scatter-to-thumbnail hover; JS-based blink comparator.

---

## Phase 1 — Perceptual dedup with DBSCAN

> **Status — shipped (2026-07-30).** Ships as a new `Dedup` sidebar view.
> Deviation from the plan below: scoring is **not** filtered by mute state —
> muting is a review-time visibility filter only, applied inside the Classify
> view. This avoids re-scoring whenever mute state changes and keeps the
> scored-result cache stable. `frames_for_feature` is untouched.

### Goal

Thin the candidate pool by grouping visually near-identical ROI cutouts and keeping one representative per cluster. Everything outside a cluster stays as-is (automatically "unique").

### Reconciling DBSCAN with the current data model

The handoff frames DBSCAN as "golden-independent, before class exists." In the current tool a *feature* (ROI) exists before goldens, so DBSCAN operates **per-camera, per-feature**, on the cached embeddings of the feature's ROI cutouts. This preserves the invariant that scoring is per-feature and keeps DBSCAN independent of any golden set.

For cameras with a `role="classify"` product ROI, DBSCAN on the product ROI can also run pre-product-assignment; that is a small variant of the same code path.

### Approach

- New module `scripts/dedup.py` (logic, no Streamlit) exposing:
  - `cluster(camera, feature, *, method, epsilon, min_points) -> ClusterResult`
  - `ClusterResult` — `{frame_hash → cluster_id (int or -1 for noise)}`, plus per-cluster representative frame hashes.
  - Uses the existing ResNet embedding cache (default `resnet50`); no re-extraction if cached. Falls back to CPU-family features only if ResNet is unavailable.
  - Distance metric: cosine (matches the ResNet scoring path in `methodology.md`).
- New Streamlit view `scripts/view_dedup/` (or panel inside Classify — see "Open questions"):
  - Sliders for `epsilon` and `min_points`.
  - Live readout: `N clusters covering K frames, U unique (noise) frames`.
  - Representative-selection strategy: **centroid proximity** by default; per-cluster click-to-override.
  - "Apply" writes a *soft-mute* flag to the frame in a new `dedup_mute` table — the frames are hidden from Classify by default but never deleted or moved. A "Show muted" toggle in Classify surfaces them again.
- New DB table (in `scripts/db.py`):
  - `dedup_mute(camera, feature, frame_hash, cluster_id, muted_at, source)` — append-only, revertible by clearing rows for a `(camera, feature)`.
- Muted frames are excluded from scoring caches and from candidate lists in `view_classify` unless "Show muted" is on.

### Interaction with goldens and existing labels

- **Never mute a labeled frame** and **never mute a golden.** These are asserted in `dedup.apply()` before writing rows.
- Re-running dedup after golden refinement is fine; new mutes append. Clearing per-feature returns everything to visible.

### Verification

Manual, on `pekat-cam3 › suspension-rod-front-left` (has real near-duplicates per `findings-real-data-method-comparison.md`):

1. Cluster with default sliders → readout matches manual spot-check of visually near-identical frames.
2. Apply → Classify candidate list shrinks; muted frames disappear.
3. Toggle "Show muted" → they reappear grouped under their representatives.
4. Label a frame, then attempt to mute it → dedup skips it with a UI note.
5. Clear mutes for the feature → count returns to pre-dedup.

### Open questions (resolve before build)

- **Own view vs Classify panel?** A dedicated `view_dedup` keeps Classify uncluttered but adds a step. Panel-inside-Classify keeps the flow tight. Recommend: dedicated view for phase 1, revisit after real use.
- **Which embedding drives clustering?** Default `resnet50`; user-selectable if `resnet18` is faster on their setup. Do *not* mix classical and ResNet in one clustering run.

---

## Phase 2 — 2D embedding scatter

> **Status — shipped (2026-07-30).** Renders as a "2D scatter (sanity check)"
> expander inside the Dedup view. UMAP default; t-SNE toggle. Cached in the
> new `scatter_cache` table.

### Goal

A visual sanity check for cluster quality and (later) class separation. **Not** a decision surface — clustering decisions stay in full-dimensional space.

### Approach

- New logic module `scripts/scatter.py`:
  - `project(embeddings, *, method="umap") -> Nx2 array` — UMAP first (better cluster preservation than t-SNE on small sets), t-SNE optional.
  - Cache the projection keyed by `(camera, feature, embedding_kind, frame-set-hash)` in a new `scatter_cache` table so re-opens are instant.
- Plot inside the dedup view (Plotly scatter):
  - Color by DBSCAN cluster id; noise as grey.
  - Representative marked with a ring / larger marker.
  - Once goldens exist for the feature, overlay them as shaped markers colored by class.
  - Hover shows frame hash + thumbnail (Plotly `customdata` + a side panel; not a proper tooltip image).

### Verification

- Open scatter for a feature with obvious duplicate bursts → visually confirm clusters group together.
- Toggle to a feature with clean labels → OK vs NG goldens should visibly separate on the scatter (or reveal that they don't, which is itself useful).
- Explicit caveat text under the chart: *"2D projection distorts distances — use for sanity check only."*

### Deliberate non-goals

- No click-to-select on the scatter in phase 2 (feed a `frame_hash` list into the comparator instead — phase 3).
- No brush-select yet.

---

## Phase 3 — Pair comparator with blink mode

### Goal

Pick any two frames (from the grid, the scatter, or a search) and view them side-by-side. Optionally blink between them at a short interval to spot subtle differences.

### Approach

- New `scripts/view_compare/` — a small standalone view driven by two `frame_hash`es in session state.
- Entry points:
  - Button on any Classify thumbnail: "Compare with…" (opens a picker filtered to the current feature).
  - Selection API from the dedup view (later: from the scatter).
- Layout:
  - Two aligned ROI cutouts (same feature, same crop, resized to a shared display size).
  - Side-by-side by default.
  - **Blink mode** toggle: use `@st.fragment` with a short `st.rerun` loop or `time.sleep`-driven cycle. Interval slider (0.1 – 1.0 s). Press-and-hold not achievable in pure Streamlit; a checkbox toggle is the phase-3 substitute.
  - Fall back to a small custom component (HTML/JS with `setInterval`) *only* if the Streamlit-fragment version stutters unacceptably. **Streamlit first, JS later.**

### Verification

- Pick two visually similar frames → side-by-side view renders identical ROIs.
- Toggle blink at 0.2 s → both frames alternate visibly; no visible full-page rerun flash.
- Turn blink off → view freezes cleanly on one frame.
- Cross-cluster pair (from dedup) → same experience.

### Open question

- Blink timing under Streamlit's rerun model may feel rough even in a fragment. Timebox the fragment attempt (say, half a day of build+test). If unacceptable, defer JS component to a later plan rather than expanding scope here.

---

## Phase 4 — Uncertainty-guided golden picking

> **Status — shipped (2026-07-30).** New *Suggested goldens* panel mounts in
> Classify below Auto-assign. Slider `N` (3–20, default 10). Ranks unlabeled
> by margin ascending, keeps top 100 as the pool, then farthest-point-samples
> in `resnet50` embedding space down to N. One-click per pick writes label +
> golden together (source tag `"suggest"`). Falls back to top-N-by-margin
> when no ResNet is installed. Diamonds already show up on the Dedup 2D
> scatter live (Phase 2 code path), so no scatter change was needed.

### Goal

Instead of the user hunting for good candidates to promote to goldens, surface the most-ambiguous unlabeled candidates *for the currently-selected feature*, lightly spread across ambiguity flavors so we don't shortlist five near-identical borderline frames.

### Reconciling with what exists

- Margin already computes the ambiguity signal (`docs/methodology.md`).
- The Classify view can sort by margin today, but doesn't *actively suggest goldens*.
- Auto-assign by leaning ([auto-assign-by-leaning.md](auto-assign-by-leaning.md)) is the opposite direction — bulk-label the confident; this one bulk-*surfaces* the unconfident.

### Approach

- New panel in Classify (`scripts/view_classify/_suggest_goldens.py`):
  - Filter: unlabeled, non-golden, both leaning and margin present under the current `rank_method`.
  - Rank by `margin` ascending (smallest = most uncertain).
  - Apply light **diversity thinning**: greedy farthest-point sampling in embedding space over the top-K candidates (K ≈ 100), keep top-N (N configurable, default 10). This is the coverage-aware selection already noted as open work in `docs/current-project.md` §Known limitations.
  - Render the N candidates in a small grid with class-quick-mark buttons + a "Promote to golden" action for each.
- Explicit copy: *"These are the most ambiguous frames under `<method>`. Labeling them will sharpen class separation the most."*

### Verification

- On a feature with poor OK/NG separation (small margins): panel shows a diverse-looking set spanning the ambiguity band, not a clump of near-identical borderline frames.
- Promoting one to golden and re-refreshing scores visibly shifts margins for nearby candidates.

### Deliberate non-goals

- No auto-promotion. Every promotion is an explicit human click.
- No cross-method consensus filter for suggestions (yet).

---

## Recommended sequencing

Phases can ship independently. Recommended order and rationale:

1. **Phase 1 (DBSCAN dedup)** first — highest leverage: shrinks the pool everything else operates on.
2. **Phase 4 (uncertainty picking)** — tightens the golden loop and reuses the diversity/farthest-point work sketched in the docs already; complements Phase 1 well without depending on scatter or comparator.
3. **Phase 3 (pair comparator)** — small, self-contained, useful even without Phases 1/2/4.
4. **Phase 2 (scatter)** — visualization-only; ship last since it depends on Phase 1's clusters to be genuinely useful.

If any phase feels heavier than expected mid-build, stop and file what's left as a follow-up rather than extending scope.

## Files touched (summary)

- New: `scripts/dedup.py`, `scripts/scatter.py`, `scripts/view_dedup/`, `scripts/view_compare/`, `scripts/view_classify/_suggest_goldens.py`.
- Edited: `scripts/db.py` (new `dedup_mute`, `scatter_cache` tables), `scripts/app.py` (view dispatch), `scripts/view_classify/render.py` (mount suggest-goldens panel; respect `dedup_mute` unless "Show muted" is on).

## Out of scope for this plan

- Per-class DBSCAN strictness (tight for OK, loose for NG). The handoff flags this as unreconciled; revisit after Phase 1 real-use data.
- JS/HTML custom component for smoother blink timing — only if the Streamlit-fragment version proves too rough.
- Brush-select / lasso on the scatter.
- Alignment (phase-correlation, template-matching) and lighting normalization (CLAHE) — separately tracked under `docs/current-project.md` §Known limitations; not folded in here.
- Any change to Export.

## Related documents

- [discussions/image-sorting-tool-handoff.md](../discussions/image-sorting-tool-handoff.md) — origin.
- [docs/methodology.md](../docs/methodology.md) — leaning, margin, novelty definitions Phase 4 relies on.
- [docs/current-project.md](../docs/current-project.md) §Known limitations — candidate redundancy and farthest-point-sampling note this plan operationalizes.
- [plans/auto-assign-by-leaning.md](auto-assign-by-leaning.md) — sibling flow (bulk-confident); Phase 4 is the bulk-uncertain counterpart.
