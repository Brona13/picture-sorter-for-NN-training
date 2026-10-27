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


### Detector-anchored ROI (v1.67.0)

An ROI may be **anchored** to one target of a detector box (`flow.py`). The `rois` row is unchanged and is the rectangle as drawn on an exemplar picture; the anchor is metadata in `settings` under `roi.anchor.<feature>` (detector id, target name, `mode`, and per mode: `box` - nothing more, the ROI *is* exactly the found box (a `margin` option existed until v1.115.1; a stored `margin` is ignored); `rect` - the example picture `frame`, `follow_rotation`, and a snapshot of the rectangle's centre offset and size in pixels relative to the detector's box; the live offset is read from the ROI's current rectangle on that picture, the snapshot is used only when the example's box is gone; an anchor without `mode`, from v1.67.0, reads as `rect`). On every picture the rectangle is the found box (`box`), or the same offset from the box the detector found there (`rect`; translation only, or turned by the angle change with `follow_rotation`); the crop is the axis-aligned bounding rectangle, clipped to the picture. A picture on which the detector found no box has **no rectangle**: it gets no vectors, scores, thumbnail or measurement, and there is no fallback to the static rectangle. Labels and goldens stay scoped by camera, feature and frame. Cache keys carry the rule and the detector's signature (ROI key) and the detected centre (frame key suffix `@a=x,y[,angle]`). Deleting the detector or the target, or the ROI, removes the anchor. Resolution lives in `anchor.py` / `engine.resolve_roi_for_frame`.

An ROI may instead **read a Picture edits box** (`roi_input.py`, setting `roi.input.<feature>` = `{box}`; since v1.84.0). The ROI's crop is then cut from the box's output picture (all its steps: crops, a followed detector target, filters), and the stored rectangle is a fraction of that edited picture, not of the whole frame (connecting resets it to 0, 0, 1, 1). A picture on which a following crop has no box has no ROI picture (no vectors, scores or thumbnail). The cache key carries a hash of the box's steps and of the followed detector's signature. An ROI is anchored to a detector or reads a box, never both; the product-sorting ROI never reads a box. Source frames stay untouched.

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
- A deleted frame keeps its deletion time (`updated`) and an optional short `note` (schema v6). The Classify **Deleted** view groups deleted frames by the local day of deletion.
- Deleting clears the frame's labels and goldens in every feature of the camera; restoring does not bring them back.
- Deleted frames are left out of Dedup clustering and the 2D scatter. Deleting after a clustering re-clusters the held result without them, and the scatter reuses the cached layout for the remaining frames.

## Scores

Scores are derived data. Each scoring method can provide nearest-class distances, leaning, margin, and novelty.

- Scores never replace human labels.
- Classical and ResNet methods remain independent opinions.
- Scores from different method families are not blended.
- Switching a scoring method off is non-destructive: results and vectors stay cached and are only filtered out when read; switching it on needs one Refresh scores (the classify state reports `missing_methods`). At least one installed method is always active. Dedup, Outliers, Find similar and golden suggestions use only the active ResNet backbones.
- A picture's **verdict** (OK / NG) is derived from the OK / NG labels of the camera's quality ROIs: none = open, all equal = automatic verdict, any mix = contradiction. A user decision overrides until the inputs change (stale). Deleted pictures have no verdict; Dedup-muted pictures without a verdict are counted as duplicates, with a verdict they keep it. Classify-role ROIs and classes other than OK / NG are ignored.
- Cache validity includes frame content, feature, ROI geometry, vision settings (pre-processing filter and enabled object mask), and method.
- A feature's pre-processing filter is metadata: it changes derived vectors only, never source frames, labels, or goldens. It is stored per (camera, feature) in `settings` under `vision.<feature>`; the cache key carries a signature of it only when a filter is set or the mask is enabled. Saving new settings drops the feature's `scatter_cache` and `cluster_snapshot`.
- A feature's object mask (rectangle, circle or polygon, normalised to the ROI crop) is likewise metadata stored in `vision.<feature>`. When enabled, pixels outside it are blanked to dark grey (after the filter) before features and embeddings are computed, so scores describe the object only. It never alters source frames, labels, or goldens; a disabled mask is saved but has no effect and no cache impact.
- A feature's detector (up to three exemplar boxes, candidate count, confidence threshold, `method` `template` (default) or `model`, and for the model an input `size` 768 or 512; a different method, or a model size other than 768, makes earlier auto detections stale) is metadata in `vision.<feature>`. It finds the object's box in each frame's filtered ROI crop. Boxes live in `detections` keyed by `(camera, feature, frame hash, rank)`, normalised to the ROI crop, with `status` `auto` (detector output, replaced by re-detection and ignored once the exemplars or filter change), `reviewed` or `manual` (human decisions: never overwritten by re-detection). Detections are suggestions; a human box always wins.
- A feature's edge-angle rule (a rule-based opinion, never blended with the embedding scores) is metadata in `settings` under `rules.edge_angle.<feature>`: a line (two points) and a band half-width normalised to the ROI crop, the number of points used, and an optional expectation (angle in [0, 180), tolerance, polarity `+`/`-`). Measurements are taken on the crop after the feature's filter (never the mask). Direction is the image's polarity (which side of the edge is brighter), not the drawing order. Per-frame measurements are derived and stored by frame hash in `settings` under `rules.edge_angle.results.<feature>` with a signature of everything a measurement depends on (algorithm, filter, line, band, points); results with another signature are ignored. The verdict (`pass`, `fail`, `undetermined`) is computed from stored measurements and the current expectation, so changing the expectation needs no new run. A freeze records the rule in `stats.rules.edge_angle`.
- A feature's augmentation ranges (how far the object moves between frames; measure-and-record only, no image is ever changed) are metadata in `settings` under `augmentation.<feature>`: the reference frame, the shift source (`auto`, `detector`, `template`), whether rotation is measured, the coverage percent, an optional class filter, and the chosen ranges for `dx` and `dy` (pixels of the ROI crop, right and down positive) and `rot` (degrees, counter-clockwise on screen positive). Per-frame measurements are derived and stored by frame hash in `settings` under `augmentation.results.<feature>` with a signature of the reference frame, source, rotation option, filter and detector; results with another signature are ignored. The ranges, coverage and class filter are not part of the signature. A freeze records them in `stats.augmentation`.
- When the mask is enabled and exemplars exist, the mask is *anchored*: it is drawn on the first exemplar's frame and translated by (detected centre − exemplar centre) per frame, using only trusted detections (human boxes, or current auto boxes at or above the threshold). Frames without one keep the mask where it was drawn. A frame's vectors are cached under `<hash>@<dx>,<dy>`, so moving one box recomputes only that frame.
- Freezing a version stores the feature's vision settings with it (`stats_json` under `vision`): filter, mask, detector, the cache signature, and, when the mask is anchored, the trusted box per frame hash. This documents how that version's vectors were derived. Reverting a version restores labels and goldens only; vision settings are per-feature working metadata and are not reverted. Exports are unchanged: original full frames, goldens only.
- Margin is a ranking signal, not a calibrated probability.

## Versions

A version is an immutable snapshot recipe for one camera and feature. It stores labels, goldens, hashes, counts, score statistics, a name, notes, number, and creation time. It does not contain images.

- Freezing creates a new snapshot.
- Exactly one version per camera and feature is active.
- Reverting replaces working labels and goldens with the snapshot.
- Reverting never deletes other saved versions.
- A non-active version can be deleted (ROI and project versions alike). Deleting drops its snapshot items but keeps the history row, greyed out and marked deleted, so version numbers are never reused and gaps (v1 and v3 on disk, v2 deleted) stay explainable. Working labels and goldens and already exported files are untouched. The active version cannot be deleted, and a deleted version cannot be reverted to or exported.
- Export reads the frozen snapshot and verifies hashes.

## Project versions and export

A **project version** freezes the camera's verdicts. It is stored in the same tables as the ROI versions under the reserved feature name `@project` (ROI names cannot start with `@`); its items have `kind="verdict"` and class `OK` or `NG`, with the content hash. Only pictures with a valid verdict at freeze time are in it (open, contradictory, stale and deleted pictures are not; duplicates only if they have a verdict). Its counts record ok, ng, contradiction, stale, open, duplicates, deleted and total. It has numbering, active flag, soft deletion and downstream results like any version, but it cannot be reverted.

Export copies a project version's pictures unmodified (original filenames, no cutouts, no manifest) under `cameras/<camera>/exports/project/v<NNN>__<name>/<OK|NG>/`. ROI versions are not exported; goldens are used for scoring only.

- Source frames remain unchanged.
- A picture is exported once, into the folder of its verdict.
- Missing sources and hash mismatches are reported.
- Exports are generated artifacts, not authoritative metadata.

## Persistence

The SQLite database is `data/picture_sorter.db`, schema version 8.

Authoritative or indexed state:

- `frames`: filename/content-hash ingest catalog
- `labels`: current labels (`via` records the page or tool that set it: Classify..., Find similar, Scatter, Clusters, Outliers, Insights; the Scatter selection used to write "Dedup", which still counts as Scatter)
- `verdict_decisions`: the user's verdict for a picture (`class` OK/NG) with `inputs_sig`, a signature of which ROI said which class when it was decided; a decision whose signature no longer matches the current labels is stale. Automatic verdicts are never stored
- `goldens`: current golden marks
- `frames.removed` (epoch seconds, NULL = in use; v1.96.0): a picture taken out at Ingest. It is hidden from every module, the bin included: `datamodel.list_unsorted` leaves it out (`include_removed=True` for the catalog itself), and the label and golden readers in `labels.py` and `verdicts.py` skip its rows. Its file, labels and goldens are untouched, so bringing it back restores everything; the same content cannot be ingested again while it exists. `frames.width` / `height` are measured from the file header on first use (0 × 0 = unreadable).
- `deleted_frames`: current camera-wide soft deletions (`source` is `user` for Classify, or the tool the delete was made from: Scatter, Clusters, Outliers, Insights)
- `dedup_mute`: current feature mute set
- `detections`: per-frame object boxes for a feature (see Detector below)
- `versions` and `version_items`: explicit snapshots
- `version_results`: values measured downstream on a dataset exported from a version (`name`, numeric `value`, `note`, the `measured` day as `YYYY-MM-DD`, `created`). Several rows per version and name are allowed; the newest `measured` (then `created`) is the latest. They belong to the version row, which is only ever soft-deleted, so they outlive a deleted version. They are records, not inputs: nothing in scoring, ranking or export reads them
- Deleting a camera removes every row with its `camera` value in every table that has such a column (found from the schema), the `version_items` / `version_results` of its versions, and the `score_cache` vectors keyed by hashes that no other camera has; then its folder under `cameras/`.
- `dedup_mute` rows are written by the cluster Apply (source `dedup`) and removed one picture at a time by Classify's *Show again* (`POST classify/unmute`); there is no hand mute (v1.61.0), and the cluster Apply reconciles the whole mute set of an ROI. Mutes belong to a **Dedup box** (v1.93.0; the box id is the `feature` key of `dedup_mute`, `cluster_snapshot`, `scatter_cache`). A Classifier reads the mutes of its own rows plus those of the box feeding it (`db.muted_frames`). A Dedup box may mute a labeled frame behind a Classifier, but never a golden or a deleted frame.
- A product's name is stored in many places: the `classes_json` of the product-sorting ROI, the `class` of that ROI's labels, goldens and version items (and the keys of the version counts), the `products_json` of shared ROIs, and the prefix of the product's own ROI names (`<product>::<roi>`, which are the `feature` key of labels, goldens, versions, mutes, results, caches and detections and the end of the settings keys). `products.rename_products` / `db.rename_products` change all of them together in one transaction; no code may rename a product any other way, or the labels and the ROIs lose their connection.
- `settings`: per-camera UI settings and per-feature vision settings (`vision.<feature>`); a camera's tags are `tags` (JSON list); the chain canvas layout is `chain.canvas` (JSON `{nodes: {<id>: {x, y, label?}}, viewport}`; box ids are `ingest`, `roi:<feature>` and `classify:<ROI>` (the ROI's Classify box, derived, one per ROI); it holds layout only, the boxes and arrows are derived from `rois`, so a box whose ROI is gone is dropped on read); app-wide settings use the pseudo-camera `_global`, e.g. `methods.active` (JSON list of the scoring methods that take part: `cpu`, `resnet18`, `resnet50`)

Derived caches:

- `score_cache`: feature vectors
- `results_cache`: scored results
- `cluster_snapshot`: dedup presentation state
- `scatter_cache`: insight projection state

There are no history projections, latest-row triggers, or `current_*` tables. Direct primary keys enforce one state row per domain identity.

SQLite stores metadata and cache payloads, not image bytes. The `rois` table joined the DB in schema v3 so ROI edits benefit from the same transactional writes as labels and goldens (see `_migrate_v2_to_v3` in `app/backend/db.py` for how earlier `rois.json` files are backfilled and removed). Optional performance JSONL is diagnostics output only.

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
