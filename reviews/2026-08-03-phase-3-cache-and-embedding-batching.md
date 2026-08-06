---
name: phase-3-cache-and-embedding-batching-2026-08-03
description: Validation of bounded cache discovery, feature persistence, and neural inference batches
status: shipped
document_type: code-review
review_type: performance-validation
review_date: 2026-08-03
last_updated: 2026-08-03
overall_risk: low
critical_findings: 0
high_findings: 0
medium_findings: 0
low_findings: 0
scope: phase-3-cache-and-embedding-batching
code_changed: true
source_plan: plans/performance-and-ux-latency-improvements
baseline: reviews/2026-08-03-phase-0-performance-baseline
tags:
  - review
  - performance
  - sqlite
  - embeddings
  - batching
---

# Phase 3 cache and embedding batching

## Outcome

Phase 3 reduces cold-cache overhead in the work users encounter after adding images or changing an ROI. Cache discovery, feature writes, and neural inference now operate in bounded batches. Scoring behavior, cache keys, and invalidation rules are unchanged.

The same pipeline is used by Classify and near-duplicate analysis, so an
embedding calculated in either flow is available to the other.

## Implementation

### Cache discovery

`classify.fetch_vectors()` resolves content hashes once and loads the requested feature kinds with bounded `IN` queries. The default query group contains 400 hashes, remaining below SQLite parameter limits after the feature, ROI, and requested-kind parameters are included.

The pipeline determines all missing classical and neural kinds before loading images. Fully cached frames therefore avoid image decoding and ROI cropping.

### Feature persistence

New cache rows are written with `executemany` in bounded groups of 128 by
default. Each completed group commits independently. A later failure does not roll back previously completed inference batches.

The primary cache identity remains:

```text
(content hash, feature, normalized ROI key, feature kind)
```

Changing image content, feature, ROI geometry, or embedding backbone therefore retains the existing invalidation behavior.

### Neural inference

`embedding.embed_batch()` preprocesses cutouts, stacks tensors, and invokes the model under `torch.inference_mode()`. CPU and CUDA batch sizes are independently configurable and both default to eight.

If a model call raises `RuntimeError` for a multi-image batch, the batch is split recursively and retried. CUDA cache cleanup runs before a retry. A single-image failure is surfaced instead of hidden.

`embedding.embed()` remains as a compatible single-image wrapper.

## Before-and-after measurements

### Classical cold cache

The deterministic Phase 0 fixture was repeated with 48 frames, six goldens, 200 requested history events, 160-pixel synthetic images, temporary storage, and neural scoring disabled.

| Measurement | Phase 0 | Phase 3 | Change |
| --- | ---: | ---: | ---: |
| Total cold refresh | 1,119.6 ms | 1,048.2 ms | 6.4% faster |
| Feature/cache phase | 178.2 ms | 114.8 ms | 35.6% faster |
| Cache persistence | 68.5 ms | 14.0 ms | 79.5% faster |
| Cache lookup queries | 48 | 1 | 97.9% fewer |
| Cache commits | 48 | 1 | 97.9% fewer |

The cold comparison phase still consumed 906.3 ms, or 86.5% of the total. The warm comparison phase consumed 930.8 ms, or 95.2% of its 977.8 ms total. This is the intended target of Phase 4.

### Neural inference

The controlled neural benchmark used eight 256×256 synthetic in-memory images. Weights were loaded and one warm-up inference completed before both timings. The installed environment selected CPU and used batch size eight.

| Backbone  | Single-image calls |  Batched | Speedup | Max absolute difference |
| --------- | -----------------: | -------: | ------: | ----------------------: |
| ResNet-18 |           173.1 ms | 140.4 ms |   1.23× |                     0.0 |
| ResNet-50 |           448.9 ms | 349.1 ms |   1.29× |                     0.0 |

These figures establish a local CPU result, not a universal throughput promise. Benefits depend on processor, GPU, batch size, image count, and model runtime.

## Verification

Sixteen automated tests pass. Phase 3 coverage confirms:

- Batched vectors match one-image inference within `1e-6` absolute tolerance.
- Input order and L2 normalization are preserved.
- Capacity failures retry with smaller bounded calls.
- A cold ten-frame classical fetch uses one lookup and one write transaction.
- The corresponding warm fetch writes nothing and returns identical vectors.
- A successfully written embedding batch remains present after a later injected failure.
- Cache identity fields remain unchanged on persisted rows.
- Dedup calls the shared cache pipeline without requesting classical features.
- Existing progress, grid-state, diagnostics, and score-refresh tests still pass.

The standalone benchmark additionally checks each configured ResNet backbone with its real pretrained model and fails if single and batched outputs are not numerically equivalent.

## Operational configuration

The conservative defaults are in `scripts/config.py`:

```python
EMBEDDING_BATCH_SIZE_CPU = 8
EMBEDDING_BATCH_SIZE_CUDA = 8
FEATURE_CACHE_QUERY_BATCH_SIZE = 400
FEATURE_CACHE_WRITE_BATCH_SIZE = 128
```

Batch sizes can be tuned for a deployment after observing memory and throughput on that machine. The automatic retry is a safety net, not a substitute for an appropriate configured limit.

## Remaining performance picture

Phase 3 materially reduces the work associated with new frames and fresh ROIs, but the measured end-to-end gain is intentionally smaller because classical candidate-to-golden comparison now dominates both cold and warm refreshes.

Phase 4 should keep score semantics exact while reducing Python-level repeated comparison work and the amount of decoded feature data retained at once.
