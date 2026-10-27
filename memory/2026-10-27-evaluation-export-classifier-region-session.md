---
name: evaluation-export-classifier-region-session
description: Session 2026-10-27 (v1.109.0-v1.119.0) - Evaluation dots/heat map, Export box, Dedup without labels, no margin, Classifier region model (no default rectangle), detector-fed Classifier, Evaluation line labels a Classifier; decisions, open items
status: current
document_type: memory
session_date: 2026-10-27
---

# Session 2026-10-27: Evaluation, Export box, Classifier region (v1.109.0 - v1.119.0)

Each version has its own commit and patch (version-named); frontend changes also a `frontend-dist-vX.Y.Z.zip`. Nothing was clicked through in a real browser by Claude; the user's own check is open for all of it. Authoritative details: `docs/current-project.md` (one entry per version) and `docs/data-model.md`.

## Built
- **v1.109.0-1.113.1 Evaluation:** pass region overlay in the viewer, pass/fail/all buttons with counts, **Pass / Fail / All output dots** that feed Dedup, Picture edits and detector (1.111.0), Space shows the reference picture, Evaluation cards are Classify cards (1.112.0), heat map chart + smoothing + "densest spot as nominal" (1.113.x).
- **v1.114.0-1.114.1 Export box:** sink at the end of the Chain with OK and NG inputs (lines intersect, a picture on both is left out and reported), folders `<product>/OK|NG`, golden pictures, originals only, freeze first then export (project versions reuse `@project` rows). Last tile of the palette. Plan: `plans/export-box.md`.
- **v1.115.0-1.116.1:** Dedup no longer labels (mute and delete only; colours come from the preceding Classifier); **margin removed everywhere** (an anchored ROI / Dedup read is exactly the found box); no colour paint cursor in Dedup.
- **v1.117.0-1.117.1 Classifier region** (`region.py`): no default rectangle. `as_is` (picture as it comes in; new Classifiers), `own` (legacy), `own_pending` (chosen, not drawn/saved: no region, no scoring). Ingest gives whole pictures, so `own` is not offered there. Detector-fed Classifier: *found box* shows the cutout; *own rectangle* starts from the found box on an example picture and is pending until Save position.
- **v1.118.0:** ROI editor shows the zoomable canvas again (as-is and found-box too, read-only); the Anchor section has no Detector/Target dropdown or Set/Remove button (the line from the detector already is the anchor; changes save at once).
- **v1.118.1:** Evaluation box showed only the pass dot (fixed height clipped fail/all); it grows now.
- **v1.119.0 Evaluation line labels a Classifier:** the Evaluation can be drawn onto a Classifier (same setting as the panel pick, drawn from its *all* dot). Verdicts become labels: pass = OK, fail = NG (Classifier needs both classes), source `evaluation`, final (hand label/clear/bulk refused, 409), user only chooses Goldens; removing the line keeps them as hand labels. `flow.sync_evaluation_labels` runs when the Classifier is read.

## Decisions by the user (still his words)
- Dedup is for deleting and muting; the Classifier assigns classes for both modules.
- No margin anywhere; no default ROI; "whole picture" is not an ROI option (connect Ingest straight to the Classifier instead).
- Evaluation labels are final; only Goldens are chosen. This is "one of many scenarios".
- Run button (whole Chain) comes later, not now.

## Open / not done
- Classify still shows label buttons for an Evaluation-labeled Classifier (click gives an error); the labeling pane on the Evaluation page too.
- Run button for the whole Chain; retire the old Versions freeze/export (work item 0000); Classifier as target of other Evaluation scenarios; labeling inside the viewer on Evaluation pages.
- Shared grid/cluster/outlier workbench for Dedup and Classify (discussed, not started); possible shared cutout setting.
- Found box not outlined in the editor in found-box mode; Overview page still shows stored rectangle numbers; legacy Ingest Classifiers keep their rectangle.
- Wording of the "whole camera" scope label on a detector-fed Classifier box (offered, no answer).
- Picture-level verdict from the boxes (see the detector-count session).

## Working with this user
Short direct answers, no praise openers; simple language and step by step when asked. He applies, commits and pushes patches himself (Claude never pushes; the stop-hook "unpushed commits" message is expected). Bump `VERSION`/`RELEASED` every code change, update `docs/current-project.md` (and `docs/data-model.md` when a rule changes), say plainly what is not done and that it was not clicked through in a browser.
