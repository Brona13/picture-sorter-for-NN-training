---
name: documentation-foundation
session_date: 2026-07-29
last_updated: 2026-07-29
description: Project audit, canonical documentation foundation, terminology cleanup, and remaining work
status: current
document_type: session-handoff
metadata:
  type: project
---

# Session handoff — Documentation foundation

## Session objective

Review the project, understand its current architecture and workflow, and make its documentation more efficient and reliable for future AI-assisted work.

The work followed a one-file-at-a-time approval process.

## Main conclusions

The project has evolved from an accept/reject picture sorter into a
human-assisted dataset-governance tool with:

- Immutable source frames
- Metadata labels and golden references
- Optional product classification
- Per-product and shared quality ROIs
- Independent classical and ResNet scoring opinions
- Reproducible version snapshots and exports

The metadata and versioning foundation is stronger than the current score calibration.

The main context-cost problem was not Python line count. It was uncertainty about which documents were current and which described retired workflows.

## Canonical documents created

- `CLAUDE.md`
  - Claude project entry point
  - Reading order
  - Critical invariants
  - Safe-testing rules
  - Context-exclusion guidance

- [[current-project]]
  - Authoritative current purpose, workflow, architecture, capabilities, limitations, and open work

- [[data-model]]
  - Canonical entities, scopes, relationships, and domain invariants

## Existing documentation updated

- `README.md`
  - Rewritten as an operational entry point
  - Covers setup, running, workflow, storage, backup, and troubleshooting
  - Documents all six current views
  - Removes obsolete golden-folder instructions

- [[methodology]]
  - Rewritten as a stable scoring reference
  - Defines classical and neural methods
  - Defines class distance, leaning, margin, and novelty
  - Documents caching, observed behavior, and interpretation limits
  - Removes historical workflow commentary

## Active-code documentation cleaned

Documentation or comments were corrected in:

- `scripts/ingest.py`
- `scripts/datamodel.py`
- `scripts/app.py`
- `scripts/ui_common.py`
- `scripts/curation.py`
- `scripts/labels.py`
- `scripts/engine.py`
- `scripts/manifest.py`
- `requirements.txt`
- `requirements-embedding.txt`

No scoring, classification, persistence, or export behavior was intentionally changed. The only user-visible change was correction of the no-camera warning in `scripts/app.py`.

## Important domain rule

> A golden is always a labeled frame and inherits that label.

Related intended behavior:

- An unlabeled frame cannot be golden.
- A frame has at most one active golden class within a feature.
- Relabeling a golden moves its golden class.
- Clearing its label removes golden status.

The Streamlit UI coordinates this behavior, but the low-level persistence functions do not yet enforce every path.

The follow-up work is recorded in
[[todo-golden-invariant-enforcement]].

## Technical findings retained

- Source frames remain under `cameras/<camera>/unsorted/`.
- Labels, goldens, versions, and caches live in SQLite.
- Product-specific feature identifiers use `<product>::<roi>`.
- Shared ROIs retain one common label and golden set.
- Classical and ResNet scoring opinions remain independent.
- SSIM dominates the classical score on measured project data.
- MSE contributed little to the tested ranking.
- Many real cutouts are near duplicates.
- Observed margins can be extremely small.
- Leaning and margin must not be treated as calibrated predictions.

See [[findings-real-data-method-comparison]] for measurements.

## Work deliberately deferred

### Documentation archive

Still needed:

1. Classify old notes and plans as current, superseded, or archived.
2. Create archive folders.
3. Move obsolete documents without deleting their history.
4. Add Frontmatter such as:
   - `status: superseded`
   - `archived_date`
   - `superseded_by`
5. Update links affected by moves.
6. Preserve Obsidian navigation and Dataview discovery.

### Domain tests and enforcement

See [[todo-golden-invariant-enforcement]].

### Product improvements

Still open:

- Classical metric-scale normalization
- Coverage-aware diversity selection
- Difference heatmaps and careful alignment
- Product-aware Status and Versions grouping
- ROI-editor width behavior

## Environment observations

- The copied `.venv` points to a Python installation that is unavailable on the current machine.
- No usable system Python was found during this session.
- The Streamlit application and Python tests were therefore not run.
- Recreate `.venv` before runtime verification.
- The project root was not an active Git repository during this session.

## Recommended resume order

1. Read `CLAUDE.md`.
2. Read [[current-project]].
3. Read [[data-model]] for domain changes.
4. Read this handoff note.
5. Choose one next track:
   - Documentation archive audit, or
   - [[todo-golden-invariant-enforcement]] after restoring Python.
6. Continue using one-file-at-a-time approval.

Do not repeat the full repository survey unless the project has materially changed.
