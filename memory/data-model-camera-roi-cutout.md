---
name: data-model-camera-roi-cutout
session_date: 2026-07-08
description: Cameras hold shared frames; a feature = a named ROI; comparison is on cutouts; frames are never duplicated
last_updated: 2026-07-22
metadata:
  type: project
---

Structure decided with the user:

- **Camera** = top grouping; owns a shared `golden/` and `unsorted/` set of full frames (5 MP). Real example camera: `pekat-cam3` (feature `suspension-rod`).
- **Feature = a named ROI** (rectangle) within the camera, stored in `rois.json` in **normalised** 0–1 coords. Multiple ROIs per frame are expected.
- Comparison runs on the **cutout** (ROI cropped from a frame). Golden cutouts = same ROI cropped from golden frames.
- **Frames are stored once — never duplicated** into per-feature inboxes. This replaced the earlier "move each file" idea: instead of moving a frame, we crop → write a cutout and record the decision, marking the `(feature, frame)` pair processed so re-runs skip.

Layout: `cameras/<cam>/{golden,unsorted,rois.json,logs,features/<feature>/{selected,rejected}}`. See [[sorting-ux-decisions]] and [[project-goal-and-path1]].
