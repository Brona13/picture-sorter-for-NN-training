---
name: chain-lines-and-points
description: Chain canvas v1.74.0 - magnetic handles, no automatic lines for new boxes, ROI drags its Classify box, Calculate inputs chosen per line (whole detector or one target)
status: done (v1.74.0)
document_type: plan
created: 2026-10-20
---

# Chain: magnetic handles, drawn lines, Calculate points per line

Agreed with the user on 2026-10-20 (all open points settled in the conversation).

## Behaviour

1. **Magnetic handles.** The nearest valid anchor point within a generous radius grabs the line (start and drop);
   handles get a larger invisible hit area and the one that will be hit is highlighted while dragging.
2. **No automatic lines for new boxes.** Placing a Crop / Detector / Calculate / Evaluation creates no line.
   Exceptions: an ROI still comes with its Classify box and their line; and the **first** module placed on an
   empty flow graph that can logically follow Ingest (Crop, Detector) is connected to Ingest. A Calculate placed
   first gets no line. Existing graphs and the derived ROI lines are untouched.
3. **Delete a line.** Select it and press Delete. Flow lines (including Ingest -> Crop / Detector) are removed
   as they are; a picture box with no line simply reads the whole picture (like Ingest). Product lines into an
   ROI keep today's meaning. Locked lines stay locked.
4. **Moving.** Dragging an ROI box moves its Classify box by the same amount. Dragging the Classify box moves it
   alone (the ROI -> Classify line stays).
5. **Calculate inputs per line.** A detector has a whole-detector dot (point zero) and one dot per target.
   - A line from the whole-detector dot gives Calculate all that detector's points.
   - A line from a target dot gives that one point.
   - Calculate takes two points in total, from any mix: two of A, one of A and one of B, ...
   - Fewer or more than two points: Calculate says so; with more than two the existing A / B choice picks two.
   - Distance and angle are computed in whole-picture coordinates: a detector behind a Crop reports positions in
     the cropped picture, so its points are shifted by the crop offset before they are combined (no resize).
   - Existing graphs (one line from a detector, A / B chosen on the Calculate page) keep working unchanged.

## Backend

- `flow.create_node`: Ingest line only for the first node of the graph and only for Crop / Detector.
- `flow.disconnect` / `delete_node`: no longer put an Ingest line back (an unconnected picture box reads the whole picture).
- Flow edges may carry `point` (a target name) when the source is a detector and the target a Calculate box.
  `connect(camera, source, target, point=None)`; a Calculate box accepts several lines, other boxes keep one input.
- `flow.calc_points(graph, calc_id)`: ordered `(detector, target)` pairs from the lines; `effective_points` /
  `calc_values` / `node_detail` use it, with crop offsets for detectors with different input crops.
- `chain.get_canvas`: edge ids unique per point; `source_handle` = `t:<target>`; Ingest flow lines unlocked.
- API: `EdgeBody.point` optional (add and remove).

## Frontend

- `ChainView`: `connectionRadius`, handle CSS (bigger hit area, valid-target highlight), ROI drag carries Classify,
  Delete key on a selected line, pass the point when drawing / deleting a detector -> Calculate line.
- `chainModel.flowConnect`: detector -> Calculate accepts the whole-detector dot and target dots; target dots
  elsewhere stay refused except onto an ROI (anchor).
- Calculate page: points listed come from all its lines (picture and boxes of the first point's detector shown).

## Tests

Backend: create_node first / not first, calc on several lines (two detectors, crop offset), disconnect leaves a box
unconnected, API point round trip. Frontend: `flowConnect` with points, ROI drag carries Classify, edge ids.
Real browser check with a temporary server on temporary data (`CURATION_CAMERAS_ROOT` / `CURATION_DATA_DIR`).

## Docs

`docs/current-project.md` (chain behaviour, open work; the flow graph is not described in `docs/data-model.md`), version 1.74.0.
