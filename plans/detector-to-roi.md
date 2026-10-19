---
name: detector-to-roi
description: Drag a detector target's dot onto an ROI feature: the ROI is the found box (plus a margin) or follows a rectangle drawn relative to it
status: approved by the user 2026-10-19 ("go"); built as v1.71.0
document_type: plan
last_updated: 2026-10-19
---

# Detector → ROI by dragging a target's dot

Builds on the anchored ROI of v1.67.0 (`plans/chain-next-steps.md`, `anchor.py`). That anchor could only be set in a panel; dragging an arrow from a detector to an ROI was refused.

## Decisions (with the user, 2026-10-19)
- **A dot per target** on the detector box, labeled with the target name, like the product dots on a Classify box. One target = one dot. The box keeps its main connection point for detector → detector and detector → Calculate. The dots only fit ROI feature boxes (more targets later: Calculate points A / B, a Crop around a found box).
- **Dropping a dot on an ROI feature sets the anchor** directly; no popup. Deleting the arrow makes the ROI static again. One anchor per ROI: a second dot replaces the first; two targets = two ROIs, each with its own Classify box.
- **Two modes**, chosen in the ROI's Anchor section; a dropped arrow starts in mode *box*:
  - **box** (a): the ROI is the found box (the axis-aligned box around the found, turned example) plus a margin (default 10 % on each side, adjustable). Nothing to draw.
  - **rect** (b): the user draws a rectangle in the ROI editor, related to the found box. The anchor stores the example picture; the offset is read from the ROI's **current** rectangle, so redrawing it needs no new "Set anchor". The ROI editor opens on the example picture and shows the detector's found box (green outline) to draw against.
- Pictures where the detector found no box have no ROI (unchanged). A turned part is not straightened (a later option).
- No schema change: the anchor stays in the setting `roi.anchor.<feature>`; a v1.67.0 anchor (no `mode`) reads as mode *rect* with its stored offsets.
- Left open on purpose: detector behind an ROI / Classify with an OK/NG class filter; dots onto Calculate or Crop; straightening.

## Steps
1. `anchor.py`: `mode`, `margin`; a resolver that loads the detector results once per run (scoring called it once per picture); live offsets in mode *rect*; pure `rect_for` handles both modes; cache keys carry mode, margin, example picture.
2. API: `PUT .../anchor` takes `mode`, `margin`, optional `frame`; `GET .../anchor` returns the anchor and, for mode *rect*, the example picture with the found box (fractions) for the ROI editor.
3. Chain: the canvas edge leaves from the target's dot; per-target dots on detector boxes; `flowConnect` turns a dot → ROI drop into "set anchor"; drops from the main handle are refused with a hint.
4. ROI editor: anchored in mode *rect* → locked to the example picture, found box drawn as a reference outline.
5. Anchor section: mode, margin, example picture, follow rotation.
6. Tests, docs, version.
