---
name: navigation-and-detector-rework
description: UI navigation restructure (top bar, tool bar, status bar, tool icons, shared grid and viewer) and the Detector rework (speed, template matching, review grid), v1.42.0-v1.50.0; decisions, measured numbers, open points
session_date: 2026-10-17
last_updated: 2026-10-18
status: current
document_type: session-note
metadata:
  type: project
---

# Navigation restructure and Detector rework, v1.42.0-v1.50.0 (2026-10-17/18)

Started from the user's own notes `discussions/picture-sorter-ui-navigation-handover.md`. The approved plan is `plans/ui-navigation-restructure.md`. Canonical description: `docs/current-project.md` (sections *Navigation*, *Dedup page layout*, *Vision settings*) and the README. Earlier work: [[dedup-redesign-panel]].

## What was built, by version
- **1.42.0 (phase 1)** the sidebar is gone: a top bar (Overview, Management, Manipulation, Export, camera and product pickers, ⚙️) and a second-level tool bar. **The ROI editor is a Manipulation tool** (the user: it is a helper for focusing on a detail, not a setup step). The product picker lives only in the top bar (`PRODUCT_IN_PANEL` is gone).
- **1.43.0 (phase 2)** Dedup is three tools, Scatter first (`/dedup/:tool`, one `DedupView` so results survive switching); the right options panel scrolls on its own; a fixed bottom status bar (camera > product > ROI, hardware badge, version).
- **1.44.0 (phase 3)** tool icons, muted until the tool has left a trace on the camera (`tools_used.py`, `GET /cameras/{camera}/tools-used`, no schema change). Scatter, Clusters, Outliers, Insights stamp their labels and deletes with their name (`via`).
- **1.45.0 (phase 4)** `PictureGrid` = the shared card grid for Scatter selection, Clusters, Outliers, Insights (Classify and Verdict were first left out because their cards are server-paged). 1.45.1: panel padding (the scrolling body clipped full-width controls).
- **1.45.2-1.46.0 detector speed** 3.1 -> 37 frames/s at the default size (encode each exemplar once and each frame once, numpy suppression that stops after 10 survivors); optional input size 512 (85 frames/s, boxes less exact; the planted object was still found). Half precision exists but is off (changed which boxes win).
- **1.47.0 detector method** `detector.method`: **template matching is the default** (exact exemplar size, real similarity as confidence, ~1.5 ms/frame on the CPU, no model); the model (OWL-ViT) stays optional and its stored box now takes the exemplar's size. Reason: on shifted real photographs the model's box was far too big or wrong, template matching found the object with 0 px error. Review became a paged card grid.
- **1.48.0** one shared `PictureViewer` shell (file name under the picture, browsing, hints, key capture) used by `FrameViewer` (labeling pages, now also Classify and Insights), a Verdict viewer and the Detector review editor; review decisions show at once, cards stay in place, `POST .../detections/{frame}/restore` undoes.
- **1.48.1-1.49.0 painting and shared behaviour** `classify/painter.ts` (engine), `useGridCard.ts` (hover keys + painting for every card), `CardGrid.tsx` (layout); the painting cursor is one page-wide rule (`html.painting`) so it beats the hand cursor of links and buttons. Verdict gained sweeping.
- **1.50.0 review** icon-only card buttons; Delete deletes the picture (same soft delete as everywhere), X clears the box, A/Enter accepts, Z undoes, E adjusts; painting only for A and X; Show (7 filters with counts) and Sort (5 orders) remembered; keys moved out of the page into a hover tip.

## Decisions and rules to keep
- Names "Management" / "Manipulation" and the grouping are working labels; visual design later in Claude Design.
- **No schema change** (still v8): a bump would make the laptop's older code reject the database. "Used" tool state is derived from existing data (labels' `via`, deleted frames' `source`, settings, versions, verdict decisions), per camera; opening a tool without acting does not count. Known limit: one label row per frame, so a later relabel overwrites `via`.
- **Every card grid works the same**: only the keys, colours and what an action does differ. Add new grids through `CardGrid` + `useGridCard` + a painter, not new copies. The user asked for this twice (viewer, then painting).
- The detector's pre-processing **filter is applied to every frame and to the exemplars before detection**, for both methods (tested in `FilterBeforeDetectionTests`).
- Detection confidence of the model is relative to each frame's best box; template matching's is absolute. Detections made by another method or model size count as stale.
- Verdict's busy state is per frame (a global one made a quick sweep skip cards).

## Measured (synthetic frames, RX 7800 XT, `app/backend/benchmark_detector.py [--photos]`)
Original 3.1 fps; now 37 at 768, 85 at 512, 220 for template matching. Shifted photographs: template 100% found, 0 px; model 0-100% with errors up to ~100 px. Review actions: save ~6 ms, list ~7-17 ms for 200-1000 frames, so the lag the user felt was the card vanishing and a hidden preview, not the server.

## Unverified and open
- **None of this has been seen rendered by Claude** (the Chrome extension was never connected) and nothing was tried on the real cameras (never test against real `cameras/` or `data/picture_sorter.db`). The user judges it in the browser and reports.
- Status bar has no "frame position" (the handover mentions it; not found in the app). Background precompute of scatter/clustering and a "ready / needs refresh" indicator are parked. Hardware-badge look still to be chosen.
- Accepting a box calls `purge_derived` (drops scatter, cluster and result caches of the feature) even when the mask is off; only needed when the mask is anchored. Candidate improvement.
- The detections the user already had are stale after the default became template matching: run detection again.
- Undo is two levels per card (last decision, then a delete).
- A frontend/backend gate failed once with all checks green on rerun (a timing-dependent test); no cause found.

## Lessons
- After a rebuild the browser may show an old page: hard refresh (Ctrl+Shift+R); after a backend change restart `./run.sh`.
- In jsdom, a hovered card stays "hovered" until an explicit `mouseLeave`; user-event pointer moves are not reliable for that. Mock servers in tests must remember saves, or a refetch undoes the optimistic change.
- Commit only on request, push only on "push it" (or an explicit "commit and push"); gate on the exit codes of both suites and `tsc`.

## Working with this user (dictation glossary additions)
"texture page" / "Detect to page" = the Detector page; "Roy Editor" = ROI editor; "inside" = Insights; "listening buttons" = the card buttons; "cutter tool" = Scatter (earlier). The user answers option questions briefly and expects the full build afterwards.
