---
name: modules-chaining-canvas
description: Next steps for the Chain canvas from real-world scenarios - documenting the detector box, cascading, unifying inputs and outputs
status: current
document_type: handover
last_updated: 2026-10-19
---

# Handover: Chain canvas next steps (real-world scenarios)

Date: 2026-10-19
Context: voice discussion following `docs/current-project.md` (last updated 2026-10-18). The user reports that the app already supports a Detector box on the Chain canvas, including cascading one detector behind another. `current-project.md` does not describe this and needs updating to match the code.

Approach: work through one complete real-world scenario end to end first, then look for patterns and unify inputs and outputs later. Keep the app lean: one shared core per concept, with behaviour adapting to context, plus a clean and collapsible UI. Visual polish comes later.

## 0. Documentation to fix

- Document the Detector box on the Chain canvas and detector cascading. Per the user, a downstream detector consumes only the boxes found by the previous detector, not the full frame.
- Verify against the code before writing: cascade behaviour when an upstream detector finds nothing for a frame, whether the search region narrows at each step, and how rotation is handled.
- `current-project.md` still lists filter and detector boxes as a "next step" on the Chain page.

## 1. Scenario A: two holes, cascaded detectors

Flow: Ingest, Detector 1, Detector 2, Calculation, Evaluation.

1. **Detector 1** uses larger regions for two holes, with geometry that distinguishes them. Named `hole left` and `hole right`. It runs across about 160 pictures, finds everything, and already supports rotation.
2. **Detector 2** is chained behind Detector 1. It consumes only the boxes from Detector 1. New regions inside those boxes are named `hole left detail` and `hole right detail`.
3. Output of each detector is still just a box (no real-world measurement). Derived values are the center point and the pixel width and height.

## 2. New module: Calculation box

- Chained after a detector. It sees all boxes the last detector produced, with their names, sizes and center points. In this scenario that is two boxes.
- Offers a dropdown of pre-built functions on points in 2D space, for example length and angle. Users do not write formulas.
- The function is chosen in the module's configuration.
- Initial need: the angle between the two hole centers (hole left detail, hole right detail).
- This is separate from the existing edge-angle rule. Unify later, once more scenarios show a pattern.

## 3. New module: Evaluation box

- Separate from Calculation, chained after it.
- Takes a nominal value and a tolerance. Example: nominal 170°, tolerance ±3°. A value inside the range is OK, outside is not good.
- Split rationale (agreed in the discussion): it matches the existing Detector/Classify split, and Calculation is a pure derived number while Evaluation is a verdict that could later apply to other values. The user does not expect clutter on the canvas.
- The user mentioned earlier discussing the tolerance idea in another session; it was not working at that point.

## 4. ROI and Classify consistency

- Every ROI box gets a paired Classify box. Today the product-sorting ROI's Classify box is derived but the behaviour differs between the product ROI and feature ROIs. The user wants it identical everywhere: click ROI to edit the rectangle and recalculate, go back to the chain, click Classify to label, filter and dedupe.
- Drawing an ROI automatically creates and wires its Classify box. No state exists where an ROI lacks one.
- Remove the standalone Classify button from the tool menu, since it is meaningless without an ROI.
- Naming: keep "ROI" and "Classify". Do not invent a new name for the pair. The menu button stays "ROI".
- This changes the Chain derivation in `chain.py` and `chainModel.ts`, not just docs.

## 5. Scenario B: detector-anchored ROI

- Another camera and dataset. A Detector first finds something specific that can move slightly and yields a reference point. An ROI drawn by hand on an exemplar picture is anchored to that point, so on each frame the ROI shifts with the detected reference.
- ROI geometry becomes optionally per-frame and computed from an upstream detector's result, instead of one static normalized rectangle.
- Design principle: one ROI concept with a shared core whose behaviour depends on what feeds it.
  - Behind Ingest: hand-drawn rectangle, fixed on the whole picture.
  - Behind a Detector: offers the detector's findings and positions dynamically (anchored).
  - Behind another ROI: a slightly different relationship (to be defined).

## 6. Smaller item: edge routing

When boxes are stacked vertically, the connecting line hides behind them. Use a step or smoothstep edge type in React Flow (orthogonal routing around the boxes) so the line stays visible. This is a styling change, not a data-model change.

## 7. Open questions

- Exact semantics of cascading when upstream finds no box, and how multiple boxes from one detector map to the next detector's exemplars and names.
- Calculation function list beyond length and angle, and how it picks which two boxes or points to use.
- How the ROI-behind-ROI case should behave.
- Where verdicts from Evaluation are stored and whether they feed Verdicts or Versions.
