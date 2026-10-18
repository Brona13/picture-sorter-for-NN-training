---
name: MEMORY
description: Portable index of project memory files
status: current
document_type: index
last_updated: 2026-10-18
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
- [Review from Dedup and Insights, 1.21.0-1.22.2 (2026-10-16)](review-from-dedup-and-insights.md) — batch-label a scatter selection; clickable confusion-matrix cells open paged Classify cards for FP/FN review; rebuild/restart lesson; unverified on real data.
- [Zoom/pan viewport, 1.23.0 (2026-10-16)](zoom-pane.md) — shared ZoomPane on the Edge angle page: wheel zoom at cursor, pan, Reset/1:1, view kept across frames; rollout to the other canvases pending; unverified in a browser.
- [Methods configuration, 1.24.0 (2026-10-16)](methods-config.md) — Configuration page: global on/off for CPU/ResNet18/ResNet50, non-destructive, tagged card flags, menu emojis; unverified in a browser.
- [Camera tags + verdicts, 1.25.0-1.27.0 (2026-10-16)](camera-tags-and-verdict-plan.md) — New camera wizard and tags (1.25.0); verdict model, Verdict page, progress bar (1.26.0, schema v8); project versions and export from verdicts (1.27.0); plans/project-verdict-plan.md; unverified in a browser.
- [Laptop patches and UX round, 1.23.0-1.30.0 (2026-10-16)](laptop-patches-and-ux-round.md) — laptop patches applied (schema v8); Dedup after Ingest, tag filter, painting labels, Deleted/Verdict pagers, remembered session; build/restart and commit-hygiene lessons; unverified in a browser.
- [Dedup redesign trial, 1.31.0-1.41.0 (2026-10-17)](dedup-redesign-panel.md) — right options panel, one active function, scatter as a function, picture viewer, info tips, hardware badge, product-picker rollout rule, wheel sliders; decisions, open points, dictation glossary; the pattern to copy to other pages.
- [Navigation restructure and Detector rework, 1.42.0-1.50.0 (2026-10-18)](navigation-and-detector-rework.md) — top bar + tool bar + status bar, tool icons, shared grid / viewer / painter, Detector: 10x faster, template matching default, review card grid with delete, filter and sort; decisions, measured numbers, open points; unverified in a browser.
- [Chain canvas v1, 1.51.0 (2026-10-18)](chain-canvas-v1.md) — Chain page: boxes = Ingest + ROI instances, arrows derived from ROIs (one handle per product), layout in `chain.canvas`; not clicked through in a browser; Merge box / detector boxes / run-all parked.
