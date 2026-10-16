---
name: project-verdict-plan
description: Agreed design for camera tags, the New camera wizard, project-wide verdicts (OK/NG from all ROI labels), the Verdict page, deleted/duplicate indicators and verdict-based export
status: complete
document_type: plan
last_updated: 2026-10-16
---

# Project verdicts (decided with the user, 2026-10-16)

"Project" and "camera" are synonyms; the UI keeps the word camera.

## Releases
- v1.25.0 — New camera wizard on Overview, tags per camera with filter. Done.
- v1.26.0 — verdict model, Verdict page, progress on camera cards, label origin and page (schema v8). Done.
- v1.27.0 — project versions and export from verdicts. Done.

## Verdict model
- One verdict per picture, camera-wide: OK or NG. Only the classes `OK` and `NG` count for now; other classes and classify-role ROIs are ignored and flagged. More complex classes may come later.
- Inputs: the current label of each quality ROI for the picture. Manual / bulk / auto and the page where it was set (Classify, scatter batch, Dedup / Outliers / Find similar filter, ...) are properties of the label, shown on the Verdict page; old labels show "page unknown". All inputs weigh the same. Dedup, Edge angle etc. only filter; they write a label only when the user or Bulk/Auto-assign does.
- Rule: no input = open; all OK = OK; all NG = NG; any other combination = contradiction. NG does not win automatically. A single input is a verdict.
- Automatic verdicts are final (exportable without confirmation) and are recomputed whenever labels change.
- The user can decide on the Verdict page (also for contradictions). That decision stores a snapshot of the inputs; if an input changes later it is stale and needs a look (confirm or change). Stale verdicts are not exported.
- Deleted pictures stay camera-wide and are excluded.

## Progress on the camera card
Counted over all pictures: verdict (OK/NG), open, contradictions, stale, plus two indicators the user wants as part of the work: **deleted** (pictures not worth selecting) and **duplicates** (muted by Dedup). Muted pictures get no label and their verdict is untouched; they are not counted as open. Per-ROI "labeled" bars stay.

## Export (v1.27.0)
- Export moves from goldens to verdicts: OK and NG pictures with a valid verdict go to `OK/` and `NG/` folders, original filenames, hashes verified. Open, contradiction and stale pictures are not exported. Goldens stay for scoring.
- Project versions snapshot verdicts, export and record downstream results; no revert (the per-ROI versions keep revert and results, and lose their export button).
- Freezing with open / contradictory pictures is allowed with a warning showing the counts; the counts are stored in the version.

## Tags
Per camera, free text, autotype from tags used on any camera, remove from one camera only, case-insensitive, no global tag manager.
