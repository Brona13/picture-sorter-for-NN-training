---
name: sorting-ux-decisions
session_date: 2026-07-08
last_updated: 2026-07-15
description: Human-in-the-loop selection; materialise cutouts AND keep a manifest; ROI status must be visible
metadata:
  type: feedback
---

Decisions the user made about the sorting UX:

- **Selection = human-in-the-loop** in Streamlit: tool ranks by novelty, user reviews a thumbnail grid and accepts/rejects (plus "accept top N").
- **Output = both**: on a decision, materialize the ROI cutout into   `features/<feature>/selected|rejected/` **and** append the decision to `logs/manifest.jsonl`. Traceable + reversible (undo deletes the cutout).
- **ROIs are drawn drag-drop** on golden frames, always editable/optional; the UI must **clearly show whether ROIs are defined** (green overlay + status list).

**Why:** the curated cutouts *are* the deliverable (ready-to-train crops), and the user wants full traceability without duplicating the large source frames.
**How to apply:** never move/duplicate full frames; only write cutouts + log. See [[data-model-camera-roi-cutout]].
