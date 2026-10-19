---
name: detector-calc-chain
description: Detectors, a calculation step and a tolerance check as chain boxes: find two named targets, cascade a second detector inside their boxes, compute an angle, compare it with nominal +- tolerance
status: built (v1.66.0), to be calibrated on real frames
document_type: plan
last_updated: 2026-10-19
---

# Detector, calculation and tolerance boxes in the chain

> **Status (2026-10-19).** Approved by the user ("run the plan"). Phases 1-4 are built: the search engine (`rotsearch.py`), detector boxes and their page, the Calculate box, and the Tolerance box with Classify badges and filters (v1.66.0). Still open: nominal by clicking a picture, band dragging on the histogram. Items marked **Open** are taken as proposed unless the user says otherwise: the result shows on the ROI feature the Tolerance box is connected to, the filter stays a per-ROI pre-step.

## Real example that drives the design

A component has two identical holes and can rotate (any direction) in the picture. It is OK when the angle from hole A to hole B is within a tolerance of a nominal value, for example 175 deg +- 3 deg. Selecting OK and NG pictures by eye is slow. The holes are 35-45 px across in the user's cut-outs (the cut-out is the "full frame" of this app).

The user can tell the two holes apart by the geometry next to each hole, so each hole has its own "hole plus neighbouring geometry" look.

## Philosophy check

- Same family as the Edge angle rule: a measurement per picture compared with a nominal value and a tolerance. The result is an **opinion** (value, badge, filter, histogram). The human still labels; nothing is labelled automatically. This stays inside "out of scope: automatically replacing human labels".
- Rule-based, no PyTorch. It never blends with the classical or ResNet scores (explicit non-goal).
- The chain so far only draws existing ROIs and stores layout. These boxes store their own settings, so the chain becomes a real processing flow. This was the original intent of the canvas (`plans/chain-canvas.md`), but it is a step beyond today's "view of the ROI definitions".

## Decisions (with the user, 2026-10-19)

- Chain: **Ingest -> Detector 1 -> Detector 2 -> Calculate -> Tolerance**. A detector takes either the whole picture or the boxes of another detector as its input.
- **Detector 1** has several named targets (here "left hole + geometry", "right hole + geometry"). Each target is an example crop. The search is **rotation-aware** (the component can be turned any way). The identity of A and B comes from the target, so the angle is a directed angle, A to B.
- **Detector 2** takes each result box of Detector 1 as its search area and finds the round hole inside it. One search per input box. Its output is the exact hole centre, and it keeps the name of the box it came from (left, right). Round holes need no rotation search here.
- A picture where only one hole (or none) is found goes to **review**; the review card shows every box with its name and lets the user adjust each one. Human boxes survive a re-run (existing rule).
- **Calculate** offers only operations that fit the connected inputs. For two points: angle A to B, distance, midpoint (a point), dx, dy. Lines come later (Edge angle can become a box that outputs a line). The user picks the operation from a drop-down, never types a formula.
- **Angle convention:** 0 deg is the direction pointing right in the picture; the angle is that of the vector from the centre of hole A to the centre of hole B, 0-360 deg. A **clockwise / counter-clockwise toggle** in the right pane (with a small picture of the direction) sets the positive direction as seen on screen. The code handles the picture's y axis pointing down. **Open (confirm):** A to B as above, start of the vector at the centre of A.
- **Tolerance** compares a number with nominal +- tolerance, with wrap-around for angles (359 deg and 1 deg are 2 deg apart). The nominal can be set three ways: click a picture (takes its measured value), type it, or drag it on the histogram. The tolerance band is dragged on the same histogram. Live counts of pass, fail and undetermined follow the controls. Pictures with a missing input are undetermined.
- The measured value shows on every card, with a histogram to help choose nominal and tolerance, and Show filters for pass, fail and undetermined, like the Edge angle badges.

## Design

### Boxes and ports
- New chain node kinds: `detector`, `calc`, `tolerance`. Boxes keep a name (cosmetic), a position (in `chain.canvas` as now) and their own settings.
- Each box has typed output ports: `point`, `box`, `number`, `verdict`. An arrow is accepted only when the types fit; the Calculate drop-down lists the operations for the connected types.
- Arrows between the new boxes are **stored** (they are data flow, not derived from ROI rows). Arrows of ROI boxes stay derived. **Open:** exact storage (a `settings` key per camera for the new nodes and edges, versus a schema bump); decide after reading `chain.py` and `detections.py`.
- Palette buttons next to **+ ROI product** and **+ ROI feature**: **+ Detector**, **+ Calculate**, **+ Tolerance**. Delete shows what would be lost (settings, stored detections) before it deletes.

### Detector 1 (backend)
- Extends the template-matching method in `detector.py`: the example crop is rotated over a range of angles and the best normalised correlation wins. Coarse-to-fine to keep it fast: a coarse step over the allowed range (full 360 deg by default, or a limited range the user sets), then a fine step around the best coarse angle, then a sub-pixel refinement of the correlation peak.
- Output per target and picture: centre, a box of the example's size, the matched rotation angle, the confidence. The matched rotation is a second, free measure of the component's orientation.
- Cost is the rotation search; **benchmark first** on synthetic rotated images with known angles (like `benchmark_detector.py`), then on real frames.

### Detector 2 (backend)
- Same engine, no rotation search, run on the padded crop of each input box. The example is a hole crop (35-45 px). Sub-pixel centre.
- Later option, not in the first version: a circle fit instead of template matching, if it proves more precise for round holes.

### Calculate and Tolerance (backend)
- Pure functions, derived on read from stored detections; no PyTorch. Results are recomputed when an upstream setting changes; changing nominal, tolerance or the operation needs no new detection run.
- Precision budget: with 35-45 px holes and sub-pixel refinement a centre error of about 0.3-0.5 px is expected; at 100 px between the holes that is about 0.3 deg against a +-3 deg tolerance. **Check on real frames**; the synthetic check does not prove it.

### Review and Classify
- Review: the existing Detector review grid, extended to several named boxes per picture (state per box). Reuse the shared card grid and viewer.
- Classify: the measured value and the pass / fail / undetermined badge show on the cards of the ROI feature the Tolerance box is connected to, plus the Show filters. A freeze records the rule in the version statistics (as `stats.rules.edge_angle` does).
- **Open:** which ROI feature carries the result. Proposal: an arrow from the Tolerance box to that feature's Classify box (for this component probably a whole-picture ROI feature, since the cut-out is the full frame).

### What stays as it is
- The per-ROI Detector page (filter, detector, review, mask) is untouched in the first phases. The filter stays a per-ROI pre-step before detection, as today. **Open (confirm):** that is right for the holes example too.
- Detector boxes in the chain are a second, new way to detect; whether the two are merged later is decided after real use.

## Phases

1. **Detection engine** (backend only): rotation-aware search with named targets and sub-pixel refinement; benchmark on synthetic rotated images; no UI.
2. **Detector boxes in the chain**: node kind, stored settings and detections, a focused page to draw the example crops on a picture (rectangle tool first), cascade (Detector 2 input from Detector 1), review with named boxes.
3. **Calculate box** with typed ports and the two-point operations; the angle toggle.
4. **Tolerance box**: histogram with nominal and tolerance, three ways to set the nominal, live counts, badges and filters in Classify, freeze records.
5. Later: line type (Edge angle as a box), more operations, circle fit for holes, Merge box, "run the whole chain".

## Tests

- Backend: rotation search finds known angles on synthetic images (several angles, both holes, wrap-around at 0/360); cascade keeps left / right identity; one hole missing gives undetermined; the angle convention for both toggle directions; tolerance wrap-around; recompute rules (new nominal needs no re-detection; changed example does); delete preview counts match what is removed; typed-port validation rejects wrong connections.
- Frontend (vitest, mocked fetch): adding the boxes, port-type validation, operation drop-down contents, toggle, histogram controls, review card with two boxes.
- Temp camera roots only; never the real `cameras/` or `data/picture_sorter.db`. Not yet calibrated on real camera frames until the user tries it.

## Not in the first version

Lines and line-and-point operations, free-form formulas (never planned), automatic labelling, blending with the scoring methods.
