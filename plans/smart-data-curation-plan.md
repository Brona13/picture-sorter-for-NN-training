---
name: smart-data-curation-plan
description: Authoritative plan and implementation status for the training-data curation tool
status: active
document_type: plan
last_updated: 2026-07-27
---

# Plan & Status: Smart Training-Data Curation Tool

Portable, in-project plan (the authoritative one — the `~/.claude/plans/` copy is machine-local and does **not** travel). Purpose: curate training data for a camera-based vision-inspection **ResNet classifier** — shrink a large, repetitive image pile to a compact, diverse, correctly-labelled set, without human sorting mistakes poisoning training.

> Origin handover: [discussions/smart-data-curation.md](../discussions/smart-data-curation.md).
> Living context lives in [memory/](../memory/) (start at `MEMORY.md`).

## Status — what's built (✅) vs open (⏭)

- ✅ **Path-1 core** (pure OpenCV/NumPy, no model): camera/ROI data model; novelty scoring (HSV-histogram + MSE + `1−SSIM`, distance to nearest golden); headless CLI (`rank.py`).
- ✅ **Streamlit UI** with four views: Status, Ingest, ROI editor, Sort.
- ✅ **ROI editor** — drag-draw rectangles on a golden frame (full browser width), save as named features; per-ROI **delete = full revert** (removes ROI + cutouts + manifest history).
- ✅ **Sort** — score by novelty, accept/reject cutouts individually or via a **top-N slider** with live count/% status. Reversible via `undo.py` / manifest.
- ✅ **Ingest + de-dup** — upload buttons / folder-import for `golden` & `unsorted`; content-hash (SHA-256) **exact-duplicate** skip; per-camera `logs/ingest_index.json`; large uploads enabled via `.streamlit/config.toml`.
- ✅ **App refactored** (2026-07-09) into short modules (see architecture below).
- ✅ **Neural (ResNet) scoring family** (2026-07-16) — independent CPU-vs-Neural families chosen by a Sort-view switch; ResNet18/50 embeddings; optional torch (`requirements-embedding.txt`); device auto (CPU here, CUDA on Nvidia). See `resnet-embedding-method.md`.
- ✅ **Flow v3 — Classify & versioning** (2026-07-24) — the current core flow: labels as metadata (files never move), per-class goldens with leaning badges, all-methods refresh with a cached feature store, SQLite in `data/`, and freeze/revert/export versioning. The Sort accept/reject view is retired to `scripts/_retired/`. See `classify-and-versioning.md`.
- ⏭ **Deferred:** perceptual near-duplicate pruning; coverage-aware diversity selection; metric-scale normalisation for the CPU family (SSIM currently dominates — see `memory/findings-real-data-method-comparison.md`).

## The evolved flow (what this tool is really for)

Real workflow: batches of images arrive regularly; previously hand-sorted **OK / NG** (binary for now) to build datasets, then a **ResNet** was retrained in a **third-party tool** (NOT PEKAT — `pekat-cam3`/`ELEKTRO_*` were just an image source; that software has **no anomaly module**). Pain point: a **misfiled image poisons training**.

```
new batch → ingest + de-dup → machine QA-assist on OK/NG → human verifies flagged → clean OK & NG sets → train
```

- **Curation goal = diversity / de-dup** (not "flag the unusual").
- **Machine's role for OK/NG = QA, "catch my mistakes"** — it never decides the class; it **flags images inconsistent with the folder they were filed in**. Must live inside our tool (their software can't help). See [memory/flow-and-roadmap.md](../memory/flow-and-roadmap.md).

## Architecture (current code map)

```
scripts/
  app.py            entry: set_page_config, sidebar (camera + view radio), dispatch table
  ui_common.py      shared UI constants, image helpers, viewport width, session-state keys
  view_status.py    ┐
  view_ingest.py    │ one render(camera) per sidebar view
  view_roi_editor.py│ (view_roi_editor.py also holds the drawable-canvas compat shim)
  view_sort.py      ┘
  config.py         paths, STANDARD_SIZE, HIST_BINS, METRIC_WEIGHTS, extensions, dir names
  datamodel.py      cameras/features/ROIs enumeration + path helpers
  roi.py            ROI dataclass, normalised↔pixel, crop()
  curation.py       image load + the 3 metrics + combine + score-against-golden
  engine.py         orchestration: score_unsorted, apply_decision, purge_feature, count_cutouts
  manifest.py       decisions log (jsonl), processed keys, undo, remove_feature
  ingest.py         content-hash de-dup + ingest_files/ingest_folder + index (LOGIC, no Streamlit)
  rank.py           headless CLI ranker;  undo.py  CLI to reverse last decision
```
Convention: **plain name = logic module** (no Streamlit, unit-testable); **`view_` prefix = UI page**.

## Data model & scoring (reference)

- **Camera → ROI(=feature) → cutout.** Frames stored **once** per camera (never duplicated); a decision crops the ROI, writes a **cutout** to `features/<f>/selected|rejected/`, and records it in the manifest so re-runs skip the `(feature, frame)` pair.
- **Novelty = distance from a candidate cutout to its *nearest* golden cutout.** Three metrics, each normalised to `[0,1]`, combined by weighted average (`config.METRIC_WEIGHTS`): HSV-histogram (Bhattacharyya, OpenCV), MSE (NumPy), `1−SSIM` (scikit-image).
- **Note:** MSE is weak for these images because they **shift slightly** frame-to-frame; you can down-weight it now (`METRIC_WEIGHTS["mse"] = 0`). See the cv2/embedding strategy below.

## Feature-space strategy (cv2 vs embedding)

Full discussion in [memory/cv2-and-feature-strategy.md](../memory/cv2-and-feature-strategy.md).
Summary: use **cv2 for the plumbing** (align via `phaseCorrelation`/`matchTemplate`; lighting-normalize via CLAHE; visualize differences via `absdiff` + heatmap) regardless — it helps everything, embeddings included. The one real decision is **classical cv2 features vs a learned ResNet embedding** for the OK/NG *judgment*, driven by how subtle the defects are. Their **fixed inspection camera (controlled lighting/framing)** favours classical cv2 methods. Killer QA idea: align candidate → nearest golden → diff **heatmap** so the human sees *where* it looks off and verifies in a glance.

## Open decisions / next steps

1. **Lightweight ResNet embedding?** — install size, CPU vs 4 GB GPU, backbone, needed-vs-not.
2. **OK/NG labels** — user to confirm with colleague (likely OK / NG; maybe more classes).
3. Then: build the **QA "catch my mistakes"** flag (diff-heatmap review), and consider perceptual near-dup pruning + coverage-aware diversity.

## Run & verify (portable — works wherever the folder lands)

```powershell
# from the project root, whatever its path is on this machine:
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
streamlit run scripts\app.py          # UI at http://localhost:8501
# headless sanity check:
python scripts\rank.py --camera pekat-cam3 --feature whole-frame --top 15
```
See [README.md](../README.md) for full usage and the "moving to another machine" checklist.
