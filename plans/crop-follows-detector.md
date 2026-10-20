---
name: crop-follows-detector
description: A Crop box fed by a detector target cuts a fixed-size rectangle around the found position on every picture, optionally straightened by the target's angle
status: phase 1 (keep orientation) built as v1.77.0 on 2026-10-20 (approved by the user); phases 2 and 3 open
document_type: plan
last_updated: 2026-10-20
---

# Crop that follows a detector

## Why (the user's real case)
Detector A finds an object (it may be turned). A Crop then cuts the picture around it, and detector B and/or an ROI work on that cut. Today a Crop is one fixed rectangle, the same on every picture, and a detector cannot feed a Crop (`flow.edge_allowed`; "Crop fed by a detector" was left open in `plans/crop-box.md`).

## Decisions (with the user, 2026-10-20)
- The cut is used by **both** a following detector and an ROI.
- **Fixed size, no margin:** the rectangle is drawn once and has the same size on every picture.
- **A picture where A found nothing goes to review** (no crop, no output; the boxes after it skip it, as a cascade does today).
- **A dropdown on the Crop, "Follow the target":**
  - *Keep orientation:* the rectangle moves with A's position only; the crop is axis-aligned, pixels are the original ones.
  - *Straighten:* the picture is turned back by A's angle around A's point before the cut, so the object is always upright in the same place. The crop is resampled; corners outside the picture are filled with a plain colour.

## Design
- **Input:** a detector target (arrow from the detector with the target as the point, like Calculate's points). A Crop without a target keeps today's behaviour (fixed rectangle in fractions).
- **Setting stored on the Crop:** `follow: {detector, target, mode}`, the rectangle's size in pixels, and its offset from A's point. The user draws the rectangle once on a **whole picture** where A found the target (A's point and angle are marked on it); the offset is stored in the target's own frame, so in *Straighten* mode it turns with the object.
- **Per picture:** centre = A's found position (+ offset, turned by A's angle in *Straighten*); the crop is cut or turned and cut. No box for the target, or a cut leaving the picture in *Keep orientation*, means no output for that picture, and it is listed for review.
- **Coordinates:** today every crop offset is the same for all pictures (`input_rects`, `rect_offset`). It becomes a per-picture transform (a shift, plus a turn in *Straighten*) used by: the detector run and its picture endpoint, `calc_values` (points are taken back to the whole picture before the measurement), `anchor.py` (ROI follows a box on the crop), the geometry overlays and the Overview boxes. A box found on a straightened crop is turned back to the whole picture, and its angle gets A's angle added.
- **Staleness:** a detector or ROI behind a following Crop is stale when A is run again, the rectangle changes or the mode changes (the Crop's signature includes A's signature).
- **ROI behind the Crop:** an ROI is stored as fractions of the whole picture today. An ROI behind a following Crop would be drawn on the crop and move with it; how it is stored and how the labelling grid shows its thumbnails is the biggest open point (see Open).

## Phases
1. **Keep orientation** (translation only): allow detector to Crop, `follow` setting and per-picture offsets, Crop page with the whole picture, review list, detector behind the Crop, Calculate and anchor offsets, tests, docs.
2. **Straighten:** the dropdown's second value, the turn and its inverse everywhere above, tests with a turned synthetic object (the cut must look the same at 0, 30 and 358 degrees).
3. **ROI behind the Crop** once phases 1-2 are used on a real camera.

## Open
- ROI behind a following Crop (storage, thumbnails, the Classify grid).
- Whether the Crop page also shows the cut live for the picture in view.
- Fill colour for corners in *Straighten* (plain grey proposed).
- Several targets in one detector: the Crop follows one chosen target; a second Crop for another.
