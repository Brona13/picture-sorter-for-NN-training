---
name: handover-new-tools-plan
description: Six phases extending the app with outlier scoring, nearest-neighbour labeling, edge-angle rule tool, augmentation ranges, quality record form and pipeline hub
status: active
document_type: plan
last_updated: 2026-10-15
---

# New tools from the voice handover (spec: discussions/picture-sorter-handover.md)

## Context
The handover lists new curation tools. Cross-camera features, drift over time, UI tab reorganization and the other rule tools are out of scope. Detector page rework, ROI-scoped scatter with bulk delete, and stricter near-duplicate thresholds already exist (v1.8-v1.11). The laptop session's Overview page and related work (v1.12.0-v1.14.1) were integrated underneath Phases 1-3, which were renumbered to v1.15.0-v1.17.0.

## Rules for every phase
- Bump `VERSION`/`RELEASED`, update README, `docs/current-project.md`, and `docs/data-model.md` when the schema changes.
- Backend tests (`.venv/bin/python -m pytest`) and frontend (`npm test`, `npx tsc --noEmit`); temporary `CURATION_CAMERAS_ROOT`/`CURATION_DATA_DIR` only.
- One commit per phase; the user pushes.
- Schema changes tested on a copy of the database; remind the user to back up before the first real launch.
- Each tool is an independent opinion, never blended; the human label stays authoritative; source frames stay immutable.

## Phase 1 - Outlier scoring (v1.15.0) - done
- `outliers.py`: score = mean cosine distance to the k nearest neighbours (default 5) over the Dedup embeddings (masks and filters apply).
- Dedup view: Outliers panel with k slider, most-isolated-first card grid reusing the cluster-browser cards, scatter colouring by score.
- Derived on demand; no schema change.

## Phase 2 - Nearest-neighbour batch labeling (v1.16.0) - done
- `neighbors.py`: closest unlabeled frames to a seed frame.
- Classify card action "Find similar": distance slider, list, tick matches, apply the seed's label through the existing bulk-label path. Human confirms; goldens untouched.

## Phase 3 - Edge-angle rule tool (v1.17.0) - done
- `edge_angle.py`: band crop, feature filter, Canny, least-squares line fit through N strongest edge points; angle 0-180 degrees; polarity from pixel gradient (not click order); verdict = angle range plus polarity.
- New view: two-click line, auto rectangle with one drag handle, live crop preview with edge-point dots, point-count slider, "calibrate from this frame", tolerance.
- Settings are per-feature metadata, recorded in frozen versions; results appear in Classify as a separate pass/fail/undetermined column and filter.
- Tested on synthetic images with known angles.

## Phase 4 - Augmentation range view (v1.18.0) - done
- `motion.py`: per-frame object shift from stored detections, fallback template matching.
- View with histograms and suggested X/Y and rotation ranges (editable), saved as metadata and written to the export manifest.
- Measures and records only; no augmented images are generated (training-time augmentation is out of scope). Decision: ranges are recorded in the frozen version's statistics only; exports keep their documented 'no manifest' layout.

## Phase 5 - Quality record form (v1.19.0)
- Generic `version_results` table (schema v7): metric name, value, note, date per exported version; shown on the Versions page. Refine once the downstream metrics are known.

## Phase 6 - Pipeline stages on the Overview page (v1.20.0)
- The Overview page (laptop session, v1.12.0-v1.14.1: every camera with its reference frame and ROI cards, click to select, picture-size sliders) is the hub. Extend its ROI cards instead of rebuilding Status: a derived stage per (camera, feature) (ROI, filter/detector, deduped, labeled, goldens, scored, version frozen, exported), labeled/unlabeled progress bars, and a persistent step indicator on the other views; clicking a stage resumes that view. No new state.

## Deferred
Embedding drift over time, menu/tab UI reorganization, other rule tools (counting, presence, colour, area), `setup_torch` helper.
