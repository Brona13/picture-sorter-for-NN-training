---
name: zoom-pane
description: Shared zoom/pan viewport (ZoomPane) introduced on the Edge angle page, v1.23.0; design choices, what is unverified, and the rollout still to do
session_date: 2026-10-16
last_updated: 2026-10-16
status: current
document_type: session-note
metadata:
  type: project
---

# Zoom/pan viewport (v1.23.0, 2026-10-16)

## Built
- `ZoomPane.tsx` + `zoomGeometry.ts`: a bordered box (3/4 as high as wide, width from a Picture size slider) around a picture layer. Wheel zooms at the cursor (0.5x-16x, about 1.16x per notch); buttons Zoom out / Zoom in / Reset (fit) / 1:1; keys `+ - 0`; pan with the middle button, Space + drag (only while the pointer is over the box), or left-drag on the background when the caller says a left click draws nothing (`panOnBackground`, set in Edge angle once a line exists).
- The layer is **resized, not CSS-scaled**: handles and dots keep their screen size, and every overlay in normalised (0-1) coordinates keeps working at any zoom without recalculation (`pointerToNorm` against the layer's rectangle).
- The view is `{zoom, cx, cy}` (picture point at the box centre), not pixels, so it survives a viewport resize and a frame change of the same shape. The caller owns it: `EdgeAngleView` keeps it across frames and resets it when camera, product or ROI change.
- A left-drag pan swallows the click that follows it (no stray point). Above 300% the picture is drawn pixelated. The tool row shows the zoom percentage (100% = one picture pixel per screen pixel), the pixel under the cursor and the line's angle and length. Esc cancels a started line.
- Edge angle page: the frame dropdown has its own row under Feature (ROI) for long file names; Picture size slider (`edge.pictureSize`).

## Not verified
- Never used in a browser by Claude; the tests (194 frontend, tsc) use mocked rectangles. Wheel feel, Space+drag, middle-click autoscroll and trackpad pinch need a real mouse.

## To do (user's order: Edge angle first, the rest later)
- Use `ZoomPane` in the ROI editor (`RoiCanvas`) and the Detector (`RoiCanvas`, `ShapeCanvas`); Dedup scatter keeps its own rectangle zoom.
