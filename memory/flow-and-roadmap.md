---
name: flow-and-roadmap
session_date: 2026-07-09
last_updated: 2026-07-28
description: The end-to-end batch workflow this tool is really for, and the agreed build roadmap
metadata:
  type: project
---

Refined understanding of the real workflow (as of 2026-07-08), which extends [[project-goal-and-path1]].

**Real workflow:** the user receives **batches of images regularly**. Previously they hand-sorted them into **OK / NG** (binary for now; possibly more classes later) and retrained a **ResNet** in a **third-party tool**. Pain point: a **misfiled image** (an NG placed in OK, or vice versa) **poisons training**.

**Important corrections:**
- The software is **NOT PEKAT** — `pekat-cam3` / the `ELEKTRO_*` images were only where some sample pictures came from. Their actual training software has **no anomaly module**, so any machine-assist must live **inside our tool**.
- The framework can do detector / classifier / segmentation; they use it as a **classifier**.

**Target end-to-end flow:**
`new batch → ingest + de-dup → machine QA-assist on OK/NG → human verifies flagged → clean OK & NG sets → train`

**Two settled design decisions:**
- **Curation goal = diversity / de-dup** — shrink a large, repetitive pile to a compact, varied set (not "flag the unusual"). Real de-dup needs a *feedback loop* (accepting an image marks its neighbourhood covered so near-twins stop being offered).
- **Machine's role in OK/NG = QA, "catch my mistakes"** — it never decides the class; it **flags images whose appearance is inconsistent with the folder they were filed in**.

**Roadmap / status:**
- ✅ **Path-1 core** — camera/ROI model, ROI editor (drag-draw + full revert), novelty scoring (histogram/MSE/SSIM), human-in-the-loop Sort, manifest/undo.
- ✅ **Stage 0 Ingest + de-dup** — built 2026-07-08 (`scripts/ingest.py`, Ingest view, `.streamlit/config.toml` for large uploads). Content-hash (SHA-256) exact-duplicate skip; per-camera `logs/ingest_index.json`.
- ✅ **Sort bulk-accept slider** — "Accept top N" is a slider with live count/% status.
- ✅ **App refactor (2026-07-09)** — `app.py` split into `view_status/view_ingest/` `view_roi_editor/view_sort.py` + shared `ui_common.py` (helpers, constants, session keys). Convention: plain names = logic modules, `view_` prefix = UI pages.
- ✅ **Neural (ResNet) scoring family (2026-07-16)** — added as an INDEPENDENT family (not blended): a Sort-view switch picks CPU (classical) vs Neural (ResNet18/ResNet50 embeddings); each family is its own weighted average and finds its own nearest golden. `scripts/embedding.py` (lazy torch, optional dep via `requirements-embedding.txt`); device auto (CPU on this AMD laptop, CUDA on the Nvidia HP). Plan: `plans/resnet-embedding-method.md`. See [[cv2-and-feature-strategy]].
- ✅ **Flow v3 — Classify & versioning (2026-07-24)** — the core redesign: labels as metadata, per-class goldens + leaning badges, SQLite (`data/picture_sorter.db`), freeze/revert/export versions. Sort view retired. **Supersedes the accept/reject model.** See [[flow-v3-classify-and-versioning]]; plan `plans/classify-and-versioning.md`.
- ✅ **Golden folder removed + Classify UX (2026-07-27)** — no `golden/` folder at all (ROI editor draws on any ingested frame, with a 📌 pin); Classify **pagination** (per-page + Prev/Next, replaces the 24 cap) and **self-explaining** cold-start / one-sided states. See [[flow-v3-classify-and-versioning]].
- ✅ **Multi-product hierarchy — Phases 1–3 (2026-07-27):** the tool now supports a nested **camera → product → ROI** structure. Stage 1 = a `classify` ROI sorts every frame into a **product**; stage 2 = OK/NG quality on that product's **own** ROIs, seeing only its frames. Includes per-class **similarity bars** under each thumbnail and a `Camera → Product → View`
  sidebar that stays hidden until a classify ROI exists (existing cameras unchanged). Plan: `plans/multi-product-hierarchy.md`; details in [[multi-product-hierarchy]].
  Phase 4 (group Status/Versions by product) still open.
- ✅ **UX + model tightening (2026-07-28):** unified button row `[OK] [★] [NG]` per card (star is disabled until the frame has a label; starring makes it a reference **for that class**;
  clicking a different class moves the star with it — so a golden's class can never disagree with its label). Made the two big view files packages for editability (`view_classify/`, `view_roi_editor/` — see [[package-layout]]). Fixed a Streamlit quirk where a redundant `st.rerun()` in the Refresh handler was resetting the *Columns* / *Per page* selectboxes on every score (see [[streamlit-gotchas]] §7). Editable ROI rectangles with drag/resize handles: see [[roi-editing]]. Active OK button now green (JS tint via components iframe), active NG stays red.
- 📍 **Current state (2026-07-28):** user is **actively classifying** on `pekat-cam3` with a three-product classify ROI (`2x4` / `4x4` / `4x4RS`) and two shared quality ROIs (`screw-bottom-1`, `screw-bottom-2`, both covering all three products). Real counts as of session close — product: 135 labelled + 17 goldens (117 unclassified so far); `suspension-rod-front-left`: 35 labelled + 13 goldens; `screw-bottom-visible`: 58 + 12; `screw-bottom-1`: 3 + 3; `screw-bottom-2`: 1 + 1; `2x4::…connector D`: 11 + 8; `4x4RS::…connector D`: 1 + 1. Margins are still tiny (see [[findings-real-data-method-comparison]]).
- ⏭ **Deferred / next:** finish Phase 4 (group Status/Versions by product); perceptual near-duplicate pruning; coverage-aware diversity selection; metric-scale normalisation for the CPU family (SSIM dominates). One open TODO: [[todo-roi-image-fullwidth]]. The standalone "QA catch-my-mistakes" idea is largely absorbed into the leaning badges.

See [[sorting-ux-decisions]], [[data-model-camera-roi-cutout]], [[cv2-and-feature-strategy]].
