---
name: ui-navigation-restructure
description: Restructure the UI into Overview / Management / Manipulation / Export with a tool bar, status bar, tool icons and a shared picture grid (phases 1-4 built as v1.42-v1.45; follow-ups v1.46-v1.50 done; parked items open)
status: shipped
document_type: plan
last_updated: 2026-10-18
---

# Plan: restructure Picture Sorter navigation (from the UI navigation handover)

## Context
`discussions/picture-sorter-ui-navigation-handover.md` describes a larger UI restructure. Today the app has a flat 12-item sidebar
(`app/frontend/src/views.ts`, `App.tsx`), and the Dedup page is the trial layout (options panel on the right, three accordion
functions Clusters / Scatter / Outliers, one "active" at a time). Decisions made with the user in discussion:

- Four top-level items: **Overview**, **Management**, **Manipulation**, **Export**; ⚙️ Configuration stays a separate button.
- Manipulation opens a **second-level top bar of tools**. Selecting a tool shows only that tool's properties in the right panel.
- **ROI editor is a selection tool**, not a pipeline setup step: it moves into Manipulation among the other tools. (It is a helper for focusing on a detail to find valid/meaningful data.)
- Dedup's functions become **separate tools** (Scatter, Clusters, Outliers) under a "Duplicates" group. **Scatter comes first.** The accordion groups and the "● active" mechanism go away.
- The right panel **scrolls independently** of the centre (sticky, viewport-height, `overflow-y: auto`), for tools with many parameters.
- Project/frame position header moves to a slim fixed **bottom status bar**; camera and product picker move there or into the top bar (sidebar is removed).
- Tool icons: muted two-tone until the tool has been used in the project, colorful afterwards.
- One **shared picture grid** component for labeling/deleting, with a single "frames changed" hook.
- Names "Management" / "Manipulation" and tool grouping are working labels, not final. Visual design/colors come later in Claude Design.

## Phases (each ends green on tests; user checks in the browser before the next phase)

### Phase 1 — Navigation shell
- New top bar: Overview | Management | Manipulation | Export, ⚙️ at the end. Replace `<nav className="sidebar">` in `App.tsx`; delete sidebar CSS (`styles.css` `.sidebar*`, `.app` flex layout).
- Rework `views.ts`: group metadata. Management = Ingest (+ new camera, already in Overview). Manipulation tools: Duplicates (Scatter, Clusters, Outliers), ROI editor, Detector, Edge angle, Classify, Insights, Verdict, Augmentation. Export = Versions. Status merges into Overview or stays as a tool (decide while building; default: keep as Overview sub-view).
- Second-level bar component (new `ToolBar.tsx`) shown on Manipulation routes; routes stay as they are (`/dedup` etc.) so links, `openStage`, `StepBar`, `lastSession` keep working. Dedup routes: `/dedup/scatter`, `/dedup/clusters`, `/dedup/outliers` (redirect `/dedup` → scatter).
- Camera picker and `ProductSelect` move into the top bar for now (status bar comes in phase 2). Remove `PRODUCT_IN_PANEL` rule and the per-page "picker in sidebar" logic: product picker now lives in one place.
- Keep `HardwareBadge` + version somewhere visible (top-bar right side until phase 2).

### Phase 2 — Panel scroll + Dedup split + bottom status bar
- `SidePanel.tsx` / `styles.css` (`.right-col`, `.right-panel`): `position: sticky; top: <bar height>; max-height: calc(100vh - bars); overflow-y: auto` on `.right-panel-body` so the panel scrolls independently of the centre; stat card stays above.
- `DedupView.tsx` (790 lines): split into `ScatterTool`, `ClustersTool`, `OutliersTool` sharing embedding/product/feature controls and the cached results (keep `useJob`, `useOutliers`, `overrides`, scatter/cluster state in a shared hook or parent so switching tools keeps results). Remove `PanelGroup` open/active state, keep `PanelGroup` only if still used elsewhere. Scatter is the default and first tool.
- Bottom `StatusBar.tsx`: slim fixed bar with camera › product › ROI and frame position; replaces the page `<h2>` headers and the `StepBar` position text where duplicated. Camera/product pickers move here; hardware badge + version live here.

### Phase 3 — Tool icons: muted when unused, colorful once used (decided with the user)
**Definition (agreed):** a tool is *used* when it has left a trace in the project — stored settings/results, or an action made from it on pictures (label, delete, mute, verdict decision). Just looking does not count. **Scope: per camera** (colorful if used on any ROI of the camera).

**No schema change.** `SCHEMA_VERSION` stays 8 (a bump would make the laptop's older code reject the database). Everything is derived from existing data, as `pipeline.py` already does.

Backend (presentation-neutral, new `app/backend/tools_used.py`, thin endpoint `GET /api/cameras/{camera}/tools-used` → `{ "dedup/clusters": true, ... }` in `api/`, tests in `app/backend/tests/`):
- Stored state per tool, any ROI of the camera: Clusters = `db.muted_frames` or `dedup.load_snapshot`; ROI editor = ROIs exist (`datamodel`); Detector = `vision_settings.get` configured (reuse `pipeline._vision_configured`); Classify = labels/goldens with a Classify `via`; Edge angle = `edge_angle.get`; Augmentation = `motion.get`; Versions = `versions.list_versions` non-empty; Verdict = rows in `verdict_decisions`.
- Scatter, Outliers, Insights: a label whose `labels.via` is the tool's name, or a deleted frame whose `deleted_frames.source` is the tool's name (free text, default "user"; no migration).
- Make the tools tag their actions: `LabelBody`/`DeleteBody` (`api/classify_api.py`) get an optional `via`; `_delete_frames` passes it as the deletion `source`; frontend `api.setLabel/deleteFrame/deleteFrames/labelFrames` pass it; `classify/Card` callers in `DedupView` (Scatter selection → "Scatter", outlier cards → "Outliers", cluster browser → "Clusters"), `InsightsView` → "Insights". The existing bulk "Dedup" via from the Scatter selection becomes "Scatter" (legacy "Dedup" labels count for Scatter). `labels._DEFAULT_VIA`/Verdict page show the new names.
- Known limit (accept): `labels` keeps one row per frame, so a later relabel by another tool overwrites `via`; Scatter/Outliers/Insights may turn muted again if all their labels were overwritten. Deleted frames keep their source. Older actions stay unattributed.

Frontend: `ToolIcon.tsx` (inline SVG per tool, two-tone muted vs. colorful via CSS vars, light/dark), `views.ts` gets an `icon` id per tool instead of an emoji; `App.tsx` fetches `api.toolsUsed(camera)` on camera change and after `DATA_CHANGED` (debounced, as `StepBar` does) and passes it to the tool bar; Overview/Status/Ingest stay always colorful (no state). Keep an accessible name (icon is `aria-hidden`, label stays text); add a tooltip "not used yet / used".

Tests: backend unit tests for each trace rule and for the `via`/`source` tagging; frontend tests for the tool bar (muted vs colorful class) and for the tagged requests from Scatter/Outliers/Insights cards. Docs: `docs/current-project.md`, `docs/data-model.md` (the `via`/`source` values), README; bump to v1.44.0.

### Phase 4 — Shared picture grid (built as v1.45.0; scope narrowed: Scatter selection, Clusters, Outliers and Insights use `PictureGrid`; Classify and Verdict keep their own grids because their cards are server-paged / decision cards)
- Extract one grid component from the card grids in Classify, Insights, Outliers, Verdict, Dedup cluster browser (`classify/Card.tsx`, `ClusterBrowser.tsx`, `Pager.tsx`, `paint.ts`). Labeling/golden/delete go through it; it emits one "frames changed" event. Preserve domain invariants (docs/data-model.md); keep domain logic in backend modules.

### Follow-up work done after phase 4 (v1.45.1-v1.50.0, not in the original plan)
Detector speed-up and input size, template matching as the default method, the review as a card grid, a shared picture viewer (`PictureViewer`) for every page, a shared painter / card hook / grid layout so every grid behaves the same, and the review's delete, icon buttons, filter and sort. See `memory/navigation-and-detector-rework.md`.

### Parked (not in this plan)
Background precompute of scatter/clustering, "ready / needs refresh" indicator, final tool names, Detector page rework, progress bar rework, visual design.

## Reuse
`SidePanel.tsx`, `InfoTip.tsx`, `WheelRange.tsx`, `ProductSelect.tsx`, `HardwareBadge.tsx`, `StepBar.tsx`, `lastSession.ts`, `useJob.ts`, `classify/*` panels.

## Rules to follow while implementing (from CLAUDE.md)
- Bump `VERSION`/`RELEASED` in `app/backend/appinfo.py` with every change (minor per phase).
- Update `docs/current-project.md` (Dedup layout section, product picker rollout rule, sidebar foot) and `README.md` in the same change; update affected frontend tests (`App.test.tsx`, `DedupView.test.tsx`, others).
- Never test against real `cameras/` or `data/picture_sorter.db`; use temp `CURATION_CAMERAS_ROOT`/`CURATION_DATA_DIR`.
- Commit only on request; gate commits on test exit code.

## Verification
- Backend: `.venv/bin/python -m pytest`. Frontend: `cd app/frontend && npm test && npx tsc --noEmit`.
- Run `./run.sh` on temp data dirs; in the browser check each phase: top bar and Manipulation tool bar navigate to every old page; Dedup Scatter first, results survive switching tools; right panel scrolls independently with a tall tool (Clusters with many params) while centre stays put; status bar fixed; hard-refresh (Ctrl+Shift+R) after rebuild.
