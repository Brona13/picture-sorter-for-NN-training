---
name: 2026-11-18-start-goldens-session
description: v1.168.0 Start goldens helper for step-2 Classifiers - methods, rules agreed, what is unverified
status: current
document_type: session-note
last_updated: 2026-11-18
---

# Session 2026-11-18: Start goldens (v1.168.0)

Brief: a step-2 Classifier has OK/NG labels from the freeze, so the first goldens are the only open choice. Helper built in the options pane, per class, before any golden or score.

- Backend `golden_start.py` (pure `analyse` over frames + unit-norm embedding; `suggest` fetches one class); `suggest_goldens.peaks` split out of `center`; route `GET classify/start-goldens`.
- Default method: greedy facility location (first pick = medoid). Others: medoid, density peaks, cluster medoids, farthest-point on non-outliers, boundary (labelled likeliest mislabels, offered after centres).
- Rules: suggest, never auto-promote; labels never change; ranks not raw distances; ties never by file order (hash of name last); ResNet only, one line if none.
- Coverage curve: covered = within the typical distance to a picture's nearest quarter of the class; suggested count = gain under 5 points. Starting values, tune on real pictures.
- Not done: background job/progress and result cache (judged unnecessary at ~1400 pictures, unmeasured); not clicked in a browser; Box-rectangle cut for never-scored pictures read from code, not run.
- Reuse later: `golden_start.analyse` for import-with-labels / production-feedback (north-star-handover.md section 4).
