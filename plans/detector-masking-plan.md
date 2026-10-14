---
name: detector-masking-plan
description: Per-feature pre-processing, exemplar-based detector and anchored mask so embeddings cover the object only
status: in-progress
document_type: plan
last_updated: 2026-10-14
---

# Detector + Masking update (spec: discussions/detector-masking-spec.md)

## Context
Embeddings are computed on the whole ROI crop, so background clutter and lighting pollute similarity and OK/NOK judgments, and the object drifts inside the crop. Add per-feature pre-processing, an exemplar-based detector, and a mask anchored on the detected box, so classify/dedup/golden-suggestion use object-only embeddings. Production ResNet is out of scope. Source frames stay immutable; the human label stays authoritative; classical and ResNet stay unblended.

Release target: appinfo VERSION 1.2.0 (bump on each phase: 1.2.0, 1.3.0, ...).

## Key findings (existing code)
- Schema: `db.py` SCHEMA_VERSION=4, `_MIGRATIONS` dict, pattern `_migrate_v3_to_v4`. Generic `settings(camera,key,value)` table (`get_setting/set_setting`, db.py:523) already used by dedup (`dedup.<name>.<feature>`).
- Single crop hook: `ROI.crop` (roi.py) used by `classify._prepare_vector_cache` (classify.py:208-210) and `thumbs._generate_cutout` (thumbs.py:70-80).
- Cache: `score_cache` key = (hash, feature, roi_key, kind); roi_key is only "x,y,w,h", so pre-processing/mask/detector state is NOT in the key -> must be folded in or caches go stale. `scatter_cache` and `cluster_snapshot` also lack a settings signature.
- Dedup/scatter/suggest_goldens all go through `dedup.fetch_embeddings` -> `classify.fetch_vectors`; one change point.
- Frontend: `RoiCanvas.tsx` is rectangle-only (div overlay, normalised coords); `roiGeometry.ts` helpers reusable. No shared slider component; BulkPanel pattern (range input + preview refetch) is the model. Views register in `views.ts` AND hand-written Routes in `App.tsx`. `camera`/`product` are props from App state; each view owns its `feature`.
- No `transformers` dependency; torch features are optional-guarded (`embedding.py`, `config.EMBEDDING_ENABLED`).
- Freeze/export store no ROI/settings; export copies originals. Reproducibility of a frozen version needs a settings snapshot.

## Design decisions
1. **Per-feature settings** live in the `settings` table, key `vision.<feature>` (JSON: `{filter:{name,params}, mask:{shape,points/center/radius}, detector:{exemplars,topk,threshold}}`). No rois-table change (avoids a v5 migration for now). Domain code in new `app/backend/vision/` modules (flat imports): `preprocess.py`, `detector.py`, `masking.py`, `settings.py`.
2. **Settings signature**: `vision_sig = sha1(filter+mask+detector config)[:8]`; appended to `roi_key` (`"x,y,w,h|<sig>"`) only when settings are non-default, so existing caches stay valid. Also add the sig to `scatter_cache`/`cluster_snapshot` staleness checks.
3. **Detections** stored per frame hash: new table `detections(hash, feature, sig, x,y,w,h, conf, status)` (schema v5 + migration). `status`: auto / reviewed / manual. Manual adjustments never overwritten by re-detection.
4. **Mask application** inside the crop step: detect box -> re-anchor mask -> crop -> blank outside mask (mean value) -> embed. Object embedding = `kind` suffix `:obj`; background embedding (`:bg`) deferred (open item).
5. **Detector**: OWL-ViT image-guided via `transformers`, new optional `requirements-detector.txt`, guarded like torch backbones, lazy model load, CPU now / CUDA when available. Run as a job (`api/jobs.py`), cached by sig.
6. **Freeze reproducibility**: store the vision settings snapshot in `freeze(..., stats=...)` (`stats_json`), no schema change. Exports unchanged (full frames, goldens only).
7. Domain invariants doc: update `docs/data-model.md` + `docs/current-project.md` in the same change as each phase.

## Phases (each: tests + docs + version bump; user runs/verifies/commits)
**Phase 1 - Pre-processing filters** (DONE, v1.2.0; thumbnails intentionally left unfiltered)
- `vision/preprocess.py`: Gaussian, median, bilateral, box, NLM, morph open/close, shrink-rescale; param schema per filter (min/max/step) served to UI.
- API `api/vision_api.py` (new router, register in main.py): GET/PUT `/cameras/{c}/vision/{feature}`, POST preview (filtered image bytes for a frame).
- Apply filter in `classify._prepare_vector_cache` + thumbs; add sig to roi_key.
- UI: new `DetectorView.tsx` (`views.ts` + `App.tsx` route): filter selector, param sliders, live preview (debounced).

**Phase 2 - Shapes and mask** (DONE, v1.3.0; blank value = dark grey 64; flat modules `masking.py`/`ShapeCanvas.tsx`; "use mask" is a saved per-feature switch on the Detector page, not a per-request toggle in Classify/Dedup, so the cache key carries the mask signature)
- `vision/masking.py`: rect/circle/polygon rasterisation (normalised coords), blank-outside, anchor-to-box transform.
- Frontend: new `ShapeCanvas.tsx` (SVG, viewBox 0 0 1 1) with rectangle/circle/polygon + handles; reuse `pointerToNorm`/clamp from `roiGeometry.ts`. Add to DetectorView.
- Mask applied (fixed position, no detector yet) -> object embeddings `:obj`; Classify/Dedup get a "use mask" toggle.

**Phase 3 - Detector** (DONE, v1.4.0; schema v5 `detections`; mask anchoring = translation only, reference = first exemplar's centre; per-frame cache key `<hash>@dx,dy`; OWL-ViT path is untested against the real model, tests use a stub backend)
- `vision/detector.py` (OWL-ViT image-guided), `detections` table + v4->v5 migration, job endpoint, review endpoints (PATCH box), exemplar picker from existing frames (1-3), top-k 1-5, confidence threshold.
- Mask re-anchored per detection; low-confidence -> manual review queue in UI (move/adjust box via existing `RoiCanvas`).

**Phase 4 - Integration + reproducibility**
- Object embedding wired through dedup/scatter/suggest_goldens; signature in scatter/cluster caches.
- Snapshot settings in freeze; show in Versions view.

**Deferred**: background embedding, segmentation beyond a shape, feature-vs-camera model.

## Open questions to settle before Phase 3
- Settings scope: spec says per feature; features are keyed (camera, name), so "per feature" = per (camera, feature). Confirm.
- ~~Blank value outside mask~~: decided dark grey.
- Should exports ever include masked/filtered crops (currently full frames)?

## Verification
- Backend: `.venv/bin/python -m pytest` with `ApiTestCase` temp dirs (never real cameras/DB). Tests: each filter output shape/dtype, mask rasterisation, sig changes invalidate cache and default sig leaves old cache hits, migration v4->v5, detector with a stubbed model, freeze snapshot.
- Frontend: `cd app/frontend && npm test && npx tsc --noEmit`; tests for ShapeCanvas pointer editing (follow RoiCanvas.test.tsx mocking) and DetectorView (fetch-stub pattern).
- Manual (by Broňa): `./run.sh` on a copy of data via CURATION_* env vars; check live preview, mask on drift, detector review flow; back up data before first real-DB launch.
