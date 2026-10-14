---
name: data-model
description: Canonical entities, relationships, scopes, persistence, and invariants of the picture-curation system
status: current
document_type: specification
last_updated: 2026-08-03
schema_version: 2
---

# Data model

This document defines the current domain model independently of the user interface. Active code and tests must preserve these rules.

## Hierarchy

```text
Camera
├── source frames
├── product-classification ROI (optional)
├── camera-level quality ROIs
├── shared quality ROIs
└── products
    └── product-specific quality ROIs
```

The principal state identity is `(camera, feature, frame)`.

## Camera and frame

A camera is the top-level scope at `cameras/<camera>/`. Its source frames live permanently in `cameras/<camera>/unsorted/`; despite the directory name, this is not a temporary queue.

Frame rules:

- Classification never moves or modifies a source frame.
- Metadata identifies a frame by its filename within a camera.
- SQLite stores one SHA-256 catalog row per frame for indexed duplicate checks.
- A camera cannot contain two cataloged frames with the same content hash.
- The catalog can be rebuilt by scanning `unsorted/` if files were added outside the app.

## ROI and feature

ROI definitions live in the SQLite `rois` table, one row per named ROI keyed by `(camera, name)` and ordered by `position` for UI display. Coordinates `x`, `y`, `w`, and `h` are normalized fractions of image dimensions. Optional `classes` and `products` are stored as JSON columns; the `role` column distinguishes `quality` (default) from `classify`.

A feature is the identity under which frames are labeled, compared, versioned, and exported. It is normally the name of an ROI.

Feature scopes:

- Camera-level: applies to the camera's frame collection.
- Product-specific: `<product>::<roi>`, applying only to frames assigned to that product.
- Shared: one ROI and metadata scope applied to the union of selected products.

Feature rules:

- Identity is stable across labels, goldens, scores, versions, and exports.
- A product-specific identifier contains exactly one `::` separator.
- Editing ROI geometry invalidates derived scores for that feature.
- Deleting an ROI purges its labels, goldens, versions, settings, and derived caches.

## Product classification

One ROI may use `role="classify"` and define a product class list. Its labels assign frames to products and establish quality-feature scope.

- A frame belongs to at most one current product class for that feature.
- Product and quality classification are separate stages.
- Cameras without a classification ROI use the flat camera/feature workflow.

## Class vocabulary

A product-classification feature uses the product classes declared by its ROI. A quality feature uses ROI-defined classes when present, otherwise the defaults `OK` and `NG`. Classes are stored as strings.

## Labels and goldens

`labels` and `goldens` are authoritative current-state SQLite tables. They are not event histories.

Label rules:

- A frame has at most one current label per feature.
- Relabeling updates that row; clearing deletes it.
- Machine scores never become labels without an explicit user action.

Golden rules:

- A golden is an ordinary source frame marked as a trusted reference.
- A golden is always labeled and its golden class equals its label.
- A frame can be golden for at most one class per feature.
- Relabeling a golden moves its golden class atomically.
- Clearing a label removes its golden mark atomically.
- Goldens are excluded from candidate scoring.

Intentional history belongs in Versions, not in every edit operation.

## Deletion and dedup mute

`deleted_frames` and `dedup_mute` are direct current-state sets.

- Delete or mute inserts/upserts a row.
- Restore or unmute deletes the row.
- Camera-wide deletion is outside feature purge.
- Dedup mute is feature-scoped and is purged with its feature.

## Scores

Scores are derived data. Each scoring method can provide nearest-class distances, leaning, margin, and novelty.

- Scores never replace human labels.
- Classical and ResNet methods remain independent opinions.
- Scores from different method families are not blended.
- Cache validity includes frame content, feature, ROI geometry, vision settings (pre-processing filter and enabled object mask), and method.
- A feature's pre-processing filter is metadata: it changes derived vectors only, never source frames, labels, or goldens. It is stored per (camera, feature) in `settings` under `vision.<feature>`; the cache key carries a signature of it only when a filter is set or the mask is enabled. Saving new settings drops the feature's `scatter_cache` and `cluster_snapshot`.
- A feature's object mask (rectangle, circle or polygon, normalised to the ROI crop) is likewise metadata stored in `vision.<feature>`. When enabled, pixels outside it are blanked to dark grey (after the filter) before features and embeddings are computed, so scores describe the object only. It never alters source frames, labels, or goldens; a disabled mask is saved but has no effect and no cache impact.
- A feature's detector (up to three exemplar boxes, candidate count, confidence threshold) is metadata in `vision.<feature>`. It finds the object's box in each frame's filtered ROI crop. Boxes live in `detections` keyed by `(camera, feature, frame hash, rank)`, normalised to the ROI crop, with `status` `auto` (detector output, replaced by re-detection and ignored once the exemplars or filter change), `reviewed` or `manual` (human decisions: never overwritten by re-detection). Detections are suggestions; a human box always wins.
- When the mask is enabled and exemplars exist, the mask is *anchored*: it is drawn on the first exemplar's frame and translated by (detected centre − exemplar centre) per frame, using only trusted detections (human boxes, or current auto boxes at or above the threshold). Frames without one keep the mask where it was drawn. A frame's vectors are cached under `<hash>@<dx>,<dy>`, so moving one box recomputes only that frame.
- Margin is a ranking signal, not a calibrated probability.

## Versions

A version is an immutable snapshot recipe for one camera and feature. It stores labels, goldens, hashes, counts, score statistics, a name, notes, number, and creation time. It does not contain images.

- Freezing creates a new snapshot.
- Exactly one version per camera and feature is active.
- Reverting replaces working labels and goldens with the snapshot.
- Reverting never deletes other saved versions.
- A non-active version can be deleted. Deleting drops its snapshot items but keeps the history row, greyed out and marked deleted, so version numbers are never reused and gaps (v1 and v3 on disk, v2 deleted) stay explainable. Working labels and goldens and already exported files are untouched. The active version cannot be deleted, and a deleted version cannot be reverted to or exported.
- Export reads the frozen snapshot and verifies hashes.

## Export

Exports copy the version's **golden** frames only, unmodified (original filenames, no cutouts, no manifest), under `cameras/<camera>/exports/<feature>/<version>/<class>/`.

- Source frames remain unchanged.
- Labeled frames that are not golden are not exported; they exist for scoring and stay in the snapshot.
- A golden is exported once, into the folder of its class.
- Missing sources and hash mismatches are reported.
- Exports are generated artifacts, not authoritative metadata.

## Persistence

The SQLite database is `data/picture_sorter.db`, schema version 4.

Authoritative or indexed state:

- `frames`: filename/content-hash ingest catalog
- `labels`: current labels
- `goldens`: current golden marks
- `deleted_frames`: current camera-wide soft deletions
- `dedup_mute`: current feature mute set
- `detections`: per-frame object boxes for a feature (see Detector below)
- `versions` and `version_items`: explicit snapshots
- `settings`: per-camera UI settings and per-feature vision settings (`vision.<feature>`)

Derived caches:

- `score_cache`: feature vectors
- `results_cache`: scored results
- `cluster_snapshot`: dedup presentation state
- `scatter_cache`: insight projection state

There are no history projections, latest-row triggers, or `current_*` tables. Direct primary keys enforce one state row per domain identity.

SQLite stores metadata and cache payloads, not image bytes. The `rois` table joined the DB in schema v3 so ROI edits benefit from the same transactional writes as labels and goldens (see [[migration-v2-v3-rois|the v2→v3 migration]] for how earlier `rois.json` files are backfilled and removed). Optional performance JSONL is diagnostics output only.

## Clean schema boundary

Schema version 2 deliberately has no migration from older databases. An incompatible database raises `DatabaseResetRequired`. Reset it with:

```powershell
python app/backend/reset_database.py --yes
```

The reset removes database metadata/caches and retired `features/` and ingest/manifest files. It preserves `unsorted/` source images and exports. Because ROI definitions live in the database, a reset wipes them too — re-draw them in the ROI editor before re-labeling. The frame catalog and all embeddings are rebuilt as the new dataset is ingested or used.

## Related documents

- [[current-project|Current project]]
- [[methodology|Scoring methodology]]
- [[2026-08-03-sqlite-clean-break-and-storage-decision|SQLite clean-break report]]
