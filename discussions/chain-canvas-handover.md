---
name: chain-canvas-handover
description: Idea and UX notes for a visual chain canvas per camera where tools are chained freely
status: current
document_type: handover
last_updated: 2026-10-18
---

# Chain canvas: handover

## Idea
A toolbox already exists in the picture sorter. The goal is a visual "chain canvas" per camera, where the user builds the processing chain from tools, in any order, with full freedom. Logical limitations can be discussed later.

Chaining already exists in two places: product ROI feeding feature ROI, and filter feeding detector. It is not generalized anywhere else.

## Canvas UX
- Node-RED-like feel, but a light custom canvas (React Flow or similar), not a big inherited framework.
- Boxes are rounded rectangles, simple two-tone design. Each tool type has its own accent colour (e.g. ROI blue, another tool orange). Background transparent or graded (undecided).
- Boxes spawn named after the tool and can be renamed inline (e.g. "ROI Product", "ROI Feature").
- Arrows are drawn manually by dragging between boxes. Anchors stay attached while boxes move.
- Positions are remembered per camera.
- Mouse wheel zooms. Dragging empty canvas pans.
- A "fit to view" reset button zooms and centres so the whole map is visible.
- Canvas size scales with the camera: one ROI box for a simple camera, a large map for a complex one.

## Workflow
- A tool palette/toolbar: click or drag a tool to drop it on the canvas.
- The first box is Ingest, the root. It changes colour once pictures exist.
- A new tool auto-connects from the last one, but the arrow can be redrawn manually.
- Clicking a box selects it. A right-side panel (existing options-panel pattern) offers rename, properties, and a link to the tool's actual page.
- Round trip: canvas is home base, jump into the tool page to do the work, return to the canvas to extend the chain.

## Branching
- Case 1: a shared quality ROI feeds several products, one chain per product.
- Case 2: A/B comparison. Two competing approaches run in parallel (e.g. different ROI or detector), then a merge box joins them with a rule (e.g. higher score wins), and the chain continues linearly.
- Branches can be added retroactively, not only planned upfront.

## Scope decisions
- Overview page stays as it is for now. Its rework is a separate future item.
- The chain canvas is a new, separate view alongside it.
- Backend: node positions, connections and labels stored as per-camera settings, as elsewhere in the app.

## Parked for later discussion
- One-button "run the whole chain" automation.

## First test case
1. Ingest box.
2. ROI for product classification.
3. A second ROI for a feature, chained from the first.
Validate the whole mechanism on this two-box chain before adding more tools.
