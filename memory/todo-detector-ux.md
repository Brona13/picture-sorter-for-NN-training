---
name: todo-detector-ux
description: Deferred rework of the Detector page: workflow unclear, layout and element organisation need redesign
session_date: 2026-10-14
last_updated: 2026-10-15
status: done
document_type: todo
metadata:
  type: project
---

# TODO: Detector page usability

The user's words at session end: the detector functionality "is still not good", it is "unclear how it works, even I have created it with you", it "needs better layout, organize elements better". Discuss the design with the user before coding; nothing below is decided. Background: [[detector-masking]], user-facing description in the README "Detector page" section.

## Why it is confusing (from reading the current code, `views/DetectorView.tsx`, `DetectorPanel.tsx`)
- One long page with four unrelated jobs (filter, mask, detector setup, review) and no steps or headings that explain order or purpose.
- **Save settings** sits *below* the detector panel, but **Run detection** (inside the panel) is disabled until settings are saved ("Save settings first"). The button that unblocks it is further down, after the controls.
- The same ROI crop appears several times: the mask canvas, the exemplar-drawing canvas, the review canvas, and the "Result" image at the very bottom, far from the controls that change it.
- The mask has to be drawn on the **first exemplar's frame**, because the anchor is that exemplar's centre. Nothing but a text note says so, and the page-wide frame selector affects every section.
- Threshold and candidates-per-frame are saved settings, but they mostly matter for the review queue, which is a different place.
- Detection results are only visible in the review queue canvas. There is no view of "what did the detector find across frames" and no preview of the mask following the object over several frames (the Result image shows one frame).
- Mask on/off, detector present or not, anchored or not: three states that change behaviour, none shown as a status.

## Directions to consider (proposals only)
- Split into steps or tabs: 1 Filter, 2 Mask, 3 Detector (exemplars, run), 4 Review, each with a one-line purpose and a status ("not set", "saved", "N frames need review").
- One persistent preview pane (sticky) showing the current frame with filter, mask and detected box; move **Save** next to it, or autosave with an explicit state.
- Show detected boxes as overlays on a frame strip, so trusted results can be checked quickly (today only "Show all frames" lists them).
- Make the anchoring explicit: a single "mask follows object" switch with the first exemplar frame picked automatically.
- Possibly a short in-page "How this works" explanation (the same text as the README section).
- Open question from before: is the real model's confidence usable as a threshold? Check score distribution on real frames first.


## Resolution (v1.11.0)
Implemented as tabs in working order with status chips, sticky Save bar (Run saves first), one shared preview whose tool follows the tab, frame strip with boxes, review keyboard shortcuts, mask opening on the first exemplar's frame. See README "Detector page".
