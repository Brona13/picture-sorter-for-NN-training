---
name: chain-lines-and-points-session
description: Session 2026-10-20 (v1.74.0) - magnetic anchor points, no automatic lines for new boxes, ROI carries its Classify box, line selection and Delete, Calculate points chosen per line; decisions, rules, what was checked, open items
status: current
document_type: memory
session_date: 2026-10-20
---

# Session 2026-10-20: Chain lines and Calculate points (v1.74.0)

One feature round, committed and pushed as `dd986cb` (plan `plans/chain-lines-and-points.md`, status done). Worked the agreed way: the user described the wish by voice, I restated it and listed open points (a to f), the user answered in two rounds, then the plan was written and built.

## Rules agreed with the user

- **Magnetic anchor points:** a dragged line snaps to the nearest valid dot (radius 40 px), dots have a big invisible hit area and glow green when they will take the line.
- **No automatic lines for new boxes.** Exception 1: an ROI comes with its Classify box and their line. Exception 2: the **first** box on an empty flow graph that can logically follow Ingest (Crop, Detector) joins Ingest by itself; a Calculate placed first gets no line; later boxes get none. **Existing graphs and layouts stay as they are** (existing auto-lines such as Ingest to ROI are kept).
- **Moving:** dragging an ROI always carries its Classify box; dragging Classify moves it alone ("like an engine pulling a wagon").
- **Deleting:** select a line, press Delete. Ingest lines can be deleted too; a Crop / Detector with no line reads the whole picture (nothing reconnects it).
- **Calculate inputs:** a detector has a main dot (the whole detector, "point zero") and one dot per target. Calculate takes **two points in total** from any mix of lines (two of A, one of A and one of B, or the whole of a two-target detector). The line drawn shows how it is configured. Distance and angle are measured on the whole picture; a Crop only shifts positions (no resize), so values are the same.

## What was built

- Backend: `flow.create_node` (Ingest line only for the first box), `connect` / `disconnect` with an optional `point`, `calc_points`, `point_keys`, `calc_detector`, `calc_values` with crop offsets (`_frame_sizes` reads image headers only when the two detectors have different input crops), `disconnect` and `delete_node` no longer reconnect to Ingest, canvas edge ids `<src>-><tgt>#<point>` with `source_handle` `t:<point>`, `EdgeBody.point`.
- Frontend: `connectionRadius`, handle CSS, `classifyFollows` in `chain/chainModel.ts`, `flowConnect` returns `point`, edge selection state in `ChainView` (**edge selection never worked before**: the edges are a controlled list without `onEdgesChange`), Delete / Backspace key, a box delete no longer drops its lines first.
- A point key is the target name, or `det:N/name` when two detectors share the name; stored `a` / `b` of old Calculate boxes keep working.

## Checked

Backend 533 and frontend 574 tests pass, `tsc` clean. Headless Chrome on a temporary camera (port 8765, temp dirs, `fuser -k` to stop): drops 22-25 px off the dot connect, ROI drag moves Classify by the same amount, Classify drag moves alone, click on a line selects it and Delete removes only that line. React Flow auto-pans when a node is dragged near the pane edge, which saves a new viewport (not a bug; it shifts coordinates between script runs).

## Open

- The Calculate page's picture (geometry overlay) only shows when both points come from one detector; points from two detectors give right numbers but no overlay.
- Two-detector Calculate not yet tried on real pictures (backend test only). The earlier open list (reference point per detector target, "no anchor" badge, picture tags, mixed resolutions warning, real-picture check of the two-hole chain) is unchanged, see `docs/current-project.md`.
- Mistake worth remembering: a scripted range replacement in `flow.py` once swallowed `delete_preview`, `delete_node`, `drop_classify_edges`, `_name`, `_finite`; the tests caught it and git restored them. Check the span of a replacement before running it.
