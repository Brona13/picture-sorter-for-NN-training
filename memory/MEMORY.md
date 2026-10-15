---
name: MEMORY
description: Portable index of project memory files
status: current
document_type: index
last_updated: 2026-10-15
---

# Project Memory Index

Portable memory for the *Picture Sorter for NN Training* project. Kept inside the project (not `~/.claude/`) so it travels if the folder is moved to another machine.

- [User working style](user-working-style.md) — methodology-first, Python-comfortable, new to vision curation.
- [Project goal & Path 1](project-goal-and-path1.md) — curate a small diverse dataset; start with OpenCV stats, escalate to embeddings only if needed.
- [Data model: camera → ROI → cutout](data-model-camera-roi-cutout.md) — how frames, ROIs/features, and cutouts relate; the "don't duplicate frames" rule.
- [Memory location preference](memory-location-preference.md) — keep memory in this project folder for portability.
- [Plan file location](plan-file-location.md) — mirror every approved plan into the project's `plans/` folder, not just claude's global scratchpad.
- [UX: show content on view entry](ux-show-content-on-view-entry.md) — a view must render its content on entry when cached state exists; gates are for cold-start only.
- [Sorting UX decisions](sorting-ux-decisions.md) — human-in-the-loop, move→cutout, materialise + manifest.
- [Flow & roadmap](flow-and-roadmap.md) — real batch workflow; diversity/de-dup goal; OK/NG QA role; ingest+slider+refactor done, ResNet next.
- [cv2 & feature strategy](cv2-and-feature-strategy.md) — how cv2 maps to the tool's jobs; diff-heatmap QA idea; classical vs embedding.
- [Findings: real-data method comparison](findings-real-data-method-comparison.md) — SSIM dominates CPU family, MSE inert, frames are near-duplicates.
- [Flow v3: Classify & versioning](flow-v3-classify-and-versioning.md) — **current core flow**: labels as metadata, per-class goldens, leaning badges, SQLite, versions.
- [Multi-product hierarchy](multi-product-hierarchy.md) — extending to camera → product → ROI (multi-class product sorting); phased, Phase 1 done 2026-07-27.
- [ROI editing](roi-editing.md) — move/resize rectangles with canvas handles; moving one keeps its labels, which were judged on the old crop.
- [Package layout](package-layout.md) — `view_classify/` and `view_roi_editor/` are packages (2026-07-28); where each concern lives.
- [Streamlit gotchas](streamlit-gotchas.md) — image 404s, `st.markdown` strips `<img>`, selectbox keys, per-button CSS, redundant `st.rerun` resets widgets.
- [TODO: ROI image full-width](todo-roi-image-fullwidth.md) — deferred; editor image doesn't stretch to full browser width.
- [Session 2026-08-06: Git repo connection & Linux runtime](git-repo-connection.md) — repo connected to GitHub; camera content stays out of git; venv setup and run command for Linux.
- [React + FastAPI migration](react-fastapi-migration.md) — full migration done (steps 0-12); browser click-through still unverified; `./run.sh` launches.
- [Migration push state](migration-push-state.md) — superseded: the migration was later merged into main and pushed (see [UI polish and Windows](ui-polish-and-windows.md)).
- [UI polish and Windows (2026-10-13)](ui-polish-and-windows.md) — whole-day recap: merge pushed, theme, Classify fixes, cam3 labels cleared, run.ps1; UI never seen rendered by Claude.
- [Goldens export, versioning, GPU (2026-10-14)](goldens-export-versioning-gpu.md) — goldens-only export, Dedup before Classify, app version 1.1.1 shown in sidebar, soft-deleted versions (schema v4), DB-lock fix, work-laptop CUDA torch; how the user really uses goldens/labels.
- [Memory housekeeping (2026-10-14)](memory-housekeeping.md) — front matter aligned, notes renamed to short undated names, five dead links fixed.
- [Memory note naming](memory-note-naming.md) — short descriptive filenames, no date; date lives in front matter.
- [Detector + masking, 1.2.0-1.6.2 (2026-10-14)](detector-masking.md) — filters, mask, OWL-ViT detector, review, polygon editing, Classify keyboard shortcuts; decisions, unverified parts, build/venv lessons.
- [TODO: Detector page usability](todo-detector-ux.md) — done in 1.11.0 (tabbed workflow); kept for the analysis.
- [GPU backends and ROCm (2026-10-15)](gpu-backends-rocm.md) — CPU/CUDA/ROCm per machine, RX 7800 XT verified in `.venv-rocm`, v1.7.0; helper scripts and Windows untested.
- [Handover tools, 1.15.0-1.20.0 (2026-10-15)](handover-new-tools.md) — outliers, find similar, edge angle, augmentation ranges, downstream results, pipeline stages + the laptop's Overview integrated; unverified on real data; git/schema cautions.
