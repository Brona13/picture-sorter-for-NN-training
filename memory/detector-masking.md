---
name: detector-masking
description: Session recap 2026-10-14 (evening): filters, mask, detector, review, polygon editing, Classify keyboard shortcuts; versions 1.2.0 to 1.6.2; what is unverified and what is next
session_date: 2026-10-14
last_updated: 2026-10-14
status: current
document_type: session-handoff
metadata:
  type: project
---

# Detector + masking and Classify shortcuts (2026-10-14, evening)

Follows [[goldens-export-versioning-gpu]] (same day, versions up to 1.1.1). Plan: `plans/detector-masking-plan.md` (status complete). Spec: `discussions/detector-masking-spec.md`. Current behaviour is documented in the README ("Detector page" section), `docs/current-project.md` and `docs/data-model.md`; this note is the history and the open points.

## Goal
Embeddings were computed on the whole ROI crop, so background clutter and lighting polluted similarity and the object drifts inside the crop. Add per-feature pre-processing, an exemplar-based detector and a mask anchored on the detected box so Classify, Dedup and golden suggestions see the object only. The production ResNet is out of scope.

## What was built (all pushed to origin/main)
| Version | Commit | What |
|---|---|---|
| 1.2.0 | 2b62efc | Phase 1: pre-processing filters (`preprocess.py`, `vision_settings.py`, `api/vision_api.py`, `views/DetectorView.tsx`); settings signature in the score-cache key |
| 1.3.0 | 2b62efc | Phase 2: rectangle/circle/polygon mask (`masking.py`, `ShapeCanvas.tsx`, `shapeGeometry.ts`), dark grey (64) outside |
| 1.4.0 | 243c3c8 | Phase 3: OWL-ViT exemplar detector (`detector.py`, `detections.py`, `DetectorPanel.tsx`, `usePreview.ts`), schema v5 `detections` table, detection job, review queue, `requirements-detector.txt` |
| 1.5.0 | 02a2032 | Phase 4: vision snapshot stored in `versions.stats_json`, "vision" column in Versions |
| 1.5.1 | 151e8f4 | Review queue "Show all frames, least confident first" + confidence range; counts now cover all frames |
| 1.5.2 | 7124c13 | Polygon editing: double-click an edge adds a point, double/right-click removes, select + button |
| 1.6.0 | 378e770 | Classify: hover a card and press 1-9 to label |
| 1.6.1 | 8f35863 | Same number again removes the label; key left of 1 (`Backquote`, layout independent, Czech prints `;`) toggles golden |
| 1.6.2 | d6fb6a9 | Removed the redundant bold class line under the file name on cards |

## Decisions
- Blank value outside the mask: **dark grey** (user choice). The mask is applied after the filter.
- Settings are per (camera, feature) in `settings` under `vision.<feature>`, not a `rois` column. "Use mask" is a saved per-feature switch on the Detector page, not a per-request toggle in Classify/Dedup (deviation from the plan; keeps the cache key simple).
- Cache keys: `roi_key` carries a settings signature only when a filter is set or the mask is enabled, so old caches stayed valid. Frames with a trusted detection cache their vectors under `<hash>@dx,dy`, so moving one box recomputes one frame. Settings or box changes purge `scatter_cache`, `cluster_snapshot`, `results_cache` for the feature.
- Mask anchoring is translation only; the reference is the centre of the first exemplar's box, so the mask must be drawn on the first exemplar's frame.
- Human boxes (`reviewed`/`manual`) are never overwritten by re-detection; auto boxes go stale when the filter or exemplars change.
- Exports unchanged (full frames, goldens only). Reverting a version does not revert vision settings.

## State and caveats
- Tests at the end: 187 backend, 79 frontend, `tsc` clean. Detector tests use a **stub backend**; the user ran the real OWL-ViT once on real data: 275 frames detected at 50% threshold, none flagged for review, one kept as decided. Whether those boxes are right was not confirmed; the scores are uncalibrated.
- The user thinks the **detector page is not good yet**: unclear how it works, layout and element organisation need work. Next task, see [[todo-detector-ux]].
- Not verified in a browser by Claude: Detector page drag handles, preview, review queue, keyboard shortcuts (the user tried shortcuts and said "works quite nice").

## Environment lessons (this machine = Linux)
- **The served frontend is `app/frontend/dist/`, gitignored and stale until rebuilt.** The version label "missing" from the sidebar was just an old build. After any frontend change: `./run.sh build`, restart `./run.sh`, hard-reload (Ctrl+Shift+R). Node 22 and `node_modules` exist on Linux.
- Install the detector dependencies **into the venv**: `.venv/bin/pip install -r requirements-detector.txt` (a bare `pip` hits another Python). torch/torchvision/pillow were already in `.venv`; first detection run downloads about 600 MB.
- On the Windows work laptop there is no Node.js: Claude builds the frontend and sends `frontend-dist.zip`, the user replaces `app\frontend\dist` (see [[goldens-export-versioning-gpu]]). Not needed on Linux.
- Real `cameras/` and `data/` were never touched by tests. First start on the real DB upgrades it to schema v5 (back up `data/` first).
