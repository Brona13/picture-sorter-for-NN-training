---
name: classify-and-versioning
description: Classification flow with per-class goldens, leaning badges, SQLite, and dataset versioning
status: shipped
document_type: plan
last_updated: 2026-07-27
---

# Plan: Classify flow v3 — per-class goldens, leaning badges, SQLite, versioning

> **Status — shipped & verified (2026-07-24 → 07-27).** All of the below is built. Since then:
> the `golden/` folder was removed entirely (ROI editor draws on any ingested frame + a 📌 pin;
> Ingest is a single drop zone; `rank.py`/`undo.py` retired), and the Classify view gained
> **pagination** (per-page + Prev/Next, replacing the 24-frame cap) and **self-explaining**
> cold-start / one-sided empty states. Next up (deferred): perceptual near-duplicate pruning,
> coverage-aware diversity, CPU metric-scale normalisation.

## Context

Two evaluation sessions (2026-07-16) converged on a redesigned core flow, replacing the old accept/reject sorting. The user's model: **classification is metadata** ("sorting happens only as recording filenames + my classification") — files never move. Machine scores are **advisors**. The user iterates: mark a few **OK-golden and NG-golden** frames → **Refresh** re-scores all frames against both golden sets → **leaning badges** show which class each frame tends toward → promote more goldens or bulk-label → repeat → **freeze a version** (per camera+ROI, revertible, one active at a time) → **export** training folders. Storage: **SQLite** in the user-created `data/` folder. This is human-in-the-loop nearest-prototype classification — a sound pattern.

### User decisions (this session)
- Golden = **per-class metadata marks** (OK-golden / NG-golden per feature). The `golden/`  folder becomes **legacy** — kept only as ROI-drawing background; NO auto-seeding of marks.
- **Refresh computes ALL methods** (cpu, resnet18, resnet50) every time; disagreement is data.
- **Retire the Sort view** (Classify supersedes it). No git here → move `view_sort.py` to `scripts/_retired/` (recoverable), don't delete. `rank.py`/`undo.py`/manifest stay (legacy CLI).
- **DB scope**: new data (labels, golden marks, versions, score cache) in `data/picture_sorter.db`; `rois.json`, `ingest_index.json`, `manifest.jsonl` stay as files.
- Labels per (frame, feature); OK/NG buttons, open string schema; manual freeze; version = recipe (no image copies). Golden guidance: OK 5–15, NG 1–3+ (rarity), per class.
- Context: batches 100–1000; NG rare (<50); cold start = no NG-golden yet must work (falls back to one-sided novelty vs OK-golden — today's behavior).

## Architecture

### NEW `scripts/db.py`
SQLite at `PROJECT_ROOT/data/picture_sorter.db` (folder exists). `sqlite3` stdlib, WAL mode, `CREATE TABLE IF NOT EXISTS` schema init, short-lived connections (Streamlit-safe). Tables:
- `labels(camera, feature, frame, hash, class, source, ts)` — append-only, **latest row wins** per (camera,feature,frame); class '' = cleared. (Pattern copied from manifest.py.)
- `goldens(camera, feature, frame, hash, class, action, ts)` — append-only add/remove, latest wins.
- `score_cache(hash, feature, roi_key, kind, vec BLOB, ts)` — kind ∈ hist | gray | resnet18 | resnet50. `roi_key` = rounded ROI box string so redrawing the ROI invalidates. Vectors as
  np.tobytes; gray stored as PNG-encoded 256×256 uint8 (~20 KB) so SSIM/MSE never reload 7 MB frames. **Images never go into the DB.**
- `versions(id, camera, feature, number, name, notes, created, counts_json, stats_json, active)` — at most one active=1 per (camera,feature).
- `version_items(version_id, frame, hash, kind, class)` — kind ∈ label | golden.

### NEW `scripts/labels.py` (logic)
`set_label / clear_label / current_labels(camera, feature) / label_counts`, `mark_golden / unmark_golden / current_goldens(camera, feature) -> {class: [frames]}`, `purge_feature(camera, feature)` (labels+goldens+cache+versions rows) for ROI-purge wiring.

### NEW `scripts/classify.py` (logic — two-sided scoring with cache)
- `refresh(camera, feature, progress_cb) -> list[FrameScore]`: for every `unsorted/` frame:
  get-or-compute cached vectors (hist, gray, embeddings both backbones — model runs only on cache miss), then per method family: `d_ok` = min distance to OK-golden vectors, `d_ng` = min to NG-golden (None if no NG-goldens), `leaning` = argmin, `margin` = |d_ok−d_ng|, `novelty` = min of the two (or d_ok alone). Reuses `curation` metric fns + `embedding.embed`; distances via existing `_hist_distance/_mse_distance/_ssim_distance/cosine_distance`.
- First refresh of a 500-frame batch pays model cost once; later refreshes = distance-only, seconds. Golden frames themselves are scored too (shown as golden, excluded from candidates).
- Cold start: zero goldens → return unscored list so the UI can still browse frames to mark the first goldens.

### NEW `scripts/view_classify.py` — primary working view
- Header: feature select; counts (golden OK/NG, labeled OK/NG, unlabeled); **🔄 Refresh** button with progress bar ("uses cache — first run of a new batch is the slow one").
- Controls: rank-by (novelty ↓, most-uncertain first = margin ↑, name), method for ranking   (cpu/resnet18/resnet50 — all are computed), filter (All/Unlabeled/OK/NG/Golden/Disagree).
- Grid (reuse `ui_common.cutout_thumb`, GRID_COLS): per tile — thumbnail, name, **leaning badge** per method compactly (e.g. `OK·OK·NG`, color green/red, margin number), current mark chips (label / golden), buttons: `OK` `NG` `⭐OK` `⭐NG` (toggle/unmark).
- **Bulk selection element**: threshold slider on the active rank metric + live caption ("N frames selected") + `Label selection OK` / `Label selection NG`.
- All writes via `labels.py`; nothing moves on disk.

### NEW `scripts/versions.py` (logic)
- `freeze(camera, feature, name, notes)`: snapshot current labels+goldens (+hashes via `ingest.content_hash`/index) into versions+version_items; auto number v1,v2,…; compute
  `counts_json` (OK, NG, golden-OK, golden-NG, unlabeled) and `stats_json` (per method: novelty mean/median/min/max from last refresh cache); set active.
- `list_versions(camera, feature)` with **delta vs previous** ("+50 OK, +2 golden-NG").
- `revert(camera, feature, version_id)`: restore working labels+goldens from snapshot (append restore rows — history preserved), set active pointer.
- `export(camera, feature, version_id)`: materialize cutouts →
  `cameras/<cam>/exports/<feature>/v<NNN>__<name>/<class>/frame__feature.png`; verify hashes, report missing/changed frames; golden frames exported inside their class too.

### NEW `scripts/view_versions.py`
- Camera+feature context → freeze form (name, notes); versions table: number, name, created, counts, novelty stats, **delta line**, active marker; per version: `Revert` (confirm step, like ROI-delete) and `Export` buttons.

### Wiring / removals
- `app.py`: radio + dispatch → Status, Ingest, ROI editor, **Classify**, **Versions** (Sort removed).
- Move `scripts/view_sort.py` → `scripts/_retired/view_sort.py` (not imported).
- `view_roi_editor.py` purge → also `labels.purge_feature`.
- `view_status.py`: add labeled/golden counts per feature from DB (small).
- Docs: README (new flow section, data/ in the move-machines checklist, Sort removal), `docs/methodology.md` (flow v3: per-class goldens, leaning, versioning).
- **First execution step:** save this plan to `plans/classify-and-versioning.md`. At the end: new memory fact (flow v3 + decisions), update `memory/flow-and-roadmap.md` and
  `plans/smart-data-curation-plan.md` status.

## Reuse
`manifest.py` latest-wins pattern → DB queries; `curation.py` metric fns + `CutoutFeatures`; `embedding.py` as-is; `ui_common.cutout_thumb/roi_key/GRID_COLS/MAX_GRID`; slider+live-caption pattern from retired Sort; confirm-step pattern from ROI-delete; Windows-safe imencode/tofile write from `engine.apply_decision`; `ingest.content_hash`. `engine.score_unsorted` stays for `rank.py` (legacy CLI) — Classify uses the new `classify.py`.

## Verification
- **Headless** (synthetic camera via `CURATION_CAMERAS_ROOT`, throwaway DB via env override of data path in `db.py`): schema init; label/golden latest-wins + purge; two-sided scoring on two synthetic clusters (OK-like/NG-like → leanings correct, margins sane; no-NG-golden cold start falls back to one-sided); **cache proof**: second refresh performs zero embed calls (counter) and is ≫ faster; freeze → counts/stats/delta correct; revert restores marks; export tree `<class>/…png` + hash-mismatch reported.
- **UI drive** (`_clstest` camera, port 8502): mark ⭐OK goldens from grid → Refresh → badges + counts appear → threshold bulk-label OK → flip one to NG → freeze v1 → more labels → freeze v2 → delta line visible → revert to v1 → confirm state rolled back → export → files on disk. Screenshots; no console/server errors; real cameras untouched.
- **Regression**: app boots with Sort absent; Status/Ingest/ROI editor unaffected; `rank.py` still runs headless.
