---
name: multi-product-hierarchy
description: Nested camera, product, and ROI hierarchy for product and quality classification
status: active
document_type: plan
last_updated: 2026-07-28
---

# Plan: Multi-product hierarchy — camera → product → ROI

> **Status (2026-07-28).** ✅ **Phases 1–3 shipped & verified** — multi-class core, per-class bar visual, and the nested hierarchy + `Camera → Product → View` navigation. Since then the model was tightened further: exclusive per-product goldens replaced by "star ≡ this labelled frame is a reference" (star disabled until labelled, moves with the label; 54 legacy goldens migrated to carry labels); shared ROIs across a product subset (`ROI.products`); editable rectangles with drag/resize handles ([[roi-editing]]); active-OK-in-green tint; ROI card list redesigned with thumbnails + scope chips + inline product multiselect. **The two-stage flow is in daily use.** ⏭ Phase 4 remains: per-product grouping in Status/Versions (export-path sanitising already done).

## Context

Today the tool curates one flat axis per camera — `camera → ROI (feature)` — with each frame labeled OK/NG (free-string `class` in SQLite; everything keyed by `(camera, feature)`). The user is extending it to handle a **mixed incoming stream containing several product types**, in two stages:

1. **Product sort** — a *classification ROI* assigns every frame exactly one **product**.
2. **Quality per product** — within each product, the existing OK/NG curation runs on that product's **own** ROIs.

This is an **upstream curation stage, not a new mission**: the end goal is still clean, correctly-labeled **per-product OK/NG datasets** feeding NN (ResNet) training in the user's third-party tool. The tool stays a *golden-assisted human sorter/curator*, **not a trained classifier** — the per-class visual shows *similarity to each class's goldens* (advisory), never a calibrated probability.

### User decisions (2026-07-27 session)
- Hierarchy is **nested with teeth**: each product has its **own** OK/NG goldens, and its quality view shows **only frames classified as that product**.
- **ROI geometry differs per product** — ROIs belong to a product (products look different).
- **Every frame gets exactly one product** (classification is exhaustive); OK/NG may stay partial.
- Product classification reuses the **same golden-assisted paradigm** (mark goldens → Refresh → human confirms). No separate trained model.
- Per-picture visual = **per-class progress bars** ("treatment B") + an **uncertain marker** when the top-1/top-2 margin is tiny — essential on near-duplicate batches (see `memory/findings-real-data-method-comparison.md`).
- **Vocabulary:** *product* (level 1) vs *verdict / OK-NG* (level 2) — "class" alone is ambiguous.
- **File moving/copying stays a future feature.** Labels remain metadata; images never move.

## Architecture

**1. Composite feature keys — reuse the whole existing stack, no schema migration.** Everything is already keyed by `(camera, feature)` (`db.py`, `labels.py`, `versions.py`), so the product level is encoded in the `feature` string:
- Quality ROIs use `feature = "<product>::<roi>"` (e.g. `typeA::rod-front`) — each therefore gets   its own labels, goldens, score cache **and independent versions/export for free**.
- The classification ROI is a **top-level** feature (no prefix), `role="classify"`, whose `classes` are the product names.
- `::` is sanitised to `-` only where it reaches a filesystem path (export folders).

**2. Per-feature class vocabulary** (replaces the single global `config.CLASSES`). `ROI` (`scripts/roi.py`) gains optional `role: str = "quality"` (`"quality"` | `"classify"`) and `classes: list[str] | None = None` (None ⇒ `config.CLASSES` = OK/NG). `rois.json` carries the keys only when they deviate from the defaults, so **legacy files load byte-unchanged**. Read everywhere via `datamodel.classes_for(camera, feature)`.

**3. Frame-subset "teeth"** — `datamodel.frames_for_feature(camera, feature)`: top-level/classify features see the whole inbox; `"<product>::<roi>"` sees only frames the classification ROI labelled as `<product>`. Consumed by `classify.refresh`, `labels.counts` and `versions.freeze` instead of `datamodel.list_unsorted`.

**4. Scoring generalised binary → N-class** (`scripts/classify.py`). Per-class distances were
already computed; `MethodScore` now carries `dists: dict[class, float|None]` and derives `leaning = argmin`, `margin = (2nd-smallest − smallest)`, `novelty = min`. Two classes reproduce the old OK-vs-NG behaviour exactly.

## Phases

### Phase 1 — Multi-class core ✅ done & verified (2026-07-27)
`roi.py` role/classes · `datamodel.classes_for` / `frames_for_feature` / `classify_feature` · N-class `classify.py` · `labels.counts` + `versions.freeze` per-feature classes · `view_classify.py` + `view_versions.py` driven by `classes_for` (dynamic metrics, filters, label/golden/bulk buttons, class-colour palette).
**Verified:** unit tests (ROI round-trip, N-class ranking incl. one-sided + near-tie); a headless integration test on a throwaway 3-product camera (refresh → every non-golden frame leans to its true product → freeze counts all products → export one folder per class → per-product scoping); and real-app backward-compat on `pekat-cam3` (OK/NG still scores & renders, no errors).
**Delivers:** product sorting on a hand-defined `classify` ROI.

### Phase 2 — Per-class bar visual ✅ done & verified (2026-07-27)
- `ui_common.py`: shared `class_color()` + **`class_bars_html(dists, classes)`** — one small bar per class, length = **relative closeness** `min(d)/d` (nearest class fills the bar; a class twice as far fills half). Lengths deliberately **do not sum to 100%** — it is a similarity advisory, not a probability. Classes with no goldens render as an empty muted track. Flags **⚠ close call** when the runner-up sits within 10% of the leader. Derives `nov`/`margin` from the same `dists` so one component owns the readout.
- `view_classify.py`: render the bars under each thumbnail for the selected *Rank using* method; keep the compact per-method leaning badges (cross-method disagreement stays visible).
**Delivers:** the graphical triage the user asked for ("focus on graphical elements, not numbers").
**Verified:** component unit tests (no-goldens, clear winner, near-tie ⇒ close call, one-sided ⇒
no margin readout, exact match `d=0`, sliver clamp, HTML-escaping of product names, one leader per
card); live on `pekat-cam3` — 24 cards × 2 bars, exactly one bold leader each (18 OK / 6 NG
matching the badges), widths spanning 66–100%, **11 of 24 flagged ⚠ close call** (the honest
near-duplicate signal); dark mode inherits theme text, neutral track reads on both; logs +
console clean. *Note: bars refresh with **🔄 Refresh scores**, not on each golden click — that's
the deliberate "marking a golden must not clear the grid" behaviour.*

### Phase 3 — Nested hierarchy + navigation ✅ done & verified (2026-07-27)
- `view_roi_editor.py`: create the camera-level `classify` ROI (name its product classes) and create quality ROIs **under the selected product** (composite name, per-product geometry); the 📌 pin still picks the drawing background.
- `app.py`: sidebar becomes **`Camera → Product → View`**, plus a top-level **Product sort** entry for stage 1. Product list = the classify ROI's `classes`.
- Views compose `feature = "<product>::<roi>"`; the Phase-1 frame-subset helper scopes quality to that product's frames.
**Delivers:** the full two-stage flow end to end.
**Built:** `datamodel.compose_feature/split_feature/products/list_features_for`; sidebar Product
selector that **only appears once a classify ROI exists** (legacy cameras untouched); all views
take `(camera, product)`; feature dropdowns show **short names** via `format_func`; ROI editor
creates the classify ROI (checkbox + product names) and per-product ROIs, plus a **Products**
editor; Status generalised to heterogeneous vocabularies (product/role columns + per-class
breakdown). Also pulled forward from Phase 4: **export path sanitising** — `::` is illegal in
Windows paths, and it bit *twice* (folder **and** filename `…__<feature>.png`).
**Verified:** headless two-stage test (compose/split, stage-1 sort, per-product ROIs with distinct
geometry, teeth = 3 frames each, scoped scoring, isolation — blue untouched by red's work,
freeze+export with a sanitised path, product-list edit); in-app on `pekat-cam3` — **no Product
selector** (correct: no classify ROI), Status/ROI editor/Classify/Versions all render, real
labels intact, logs clean. *In-app creation of a classify ROI was deliberately NOT submitted —
that would write a product ROI into the real project; the flow itself is covered headlessly.*

### Phase 4 — Versioning / export / status per product ⏭ (mostly free)
`versions.export`: sanitize `::` in `exports/<product>-<roi>/…`. `view_status.py` / `view_versions.py`: group by product, dynamic class columns (Status still shows fixed OK/NG columns after Phase 1 — harmless, shows 0s). Export-to-`selected/` file moving stays **out of scope / future**.

## Verification

Run `streamlit run scripts\app.py`, per phase:
- **P1** — classify ROI with 3 products on `pekat-cam3`: goldens per product → Refresh → every frame leans to a product; bulk-label with >2 classes; freeze shows all product counts.
- **P2** — bars render under each thumbnail, update live on golden changes, show ⚠ on tight margins; check light/dark.
- **P3** — pick a product → only its frames → its own ROI → OK/NG goldens → Refresh → label; another product's frames/goldens untouched.
- **P4** — freeze + export two products independently; check `exports/` layout + hash report.
- Throughout: `preview_logs` clean, and **existing single-ROI OK/NG cameras still behave**  (absent `role`/`classes` ⇒ quality + OK/NG; absent `::` ⇒ whole inbox).

## Notes
- **No DB migration** — all additive; `class` was already a free string.
- Backward compatible by construction; legacy `rois.json` untouched on save.
- Keep `memory/multi-product-hierarchy.md` in step as phases land.
