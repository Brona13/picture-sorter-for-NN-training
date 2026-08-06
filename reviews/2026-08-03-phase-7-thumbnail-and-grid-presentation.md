---
name: phase-7-thumbnail-and-grid-presentation-2026-08-03
description: Validation of bounded encoded thumbnail caches and measured Classify grid presentation cost
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
scope: phase-7-thumbnail-and-grid-presentation
code_changed: true
source_plan: plans/performance-and-ux-latency-improvements
baseline: reviews/2026-08-03-performance-and-ux-latency-review
tags:
  - review
  - performance
  - thumbnails
  - streamlit
  - caching
---

# Phase 7 thumbnail and grid presentation

## Outcome

Phase 7 bounds thumbnail retention, substantially reduces its memory footprint, and makes the otherwise silent Classify grid-preparation interval visible.

The normal page size remains 24. Pages of 48 and 96 remain available, but the interface now explains that their first preparation and browser render take longer. The measurements do not justify adding grid virtualization yet.

## Baseline

The safe thumbnail fixture generated 96 synthetic 1280 × 960 images in a
temporary directory and prepared the same ROI crop at each supported large page size. The existing Streamlit data cache retained decoded PIL images without an entry limit.

| Page size | Cold preparation | Warm retrieval | Decoded pixel payload |
| --------: | ---------------: | -------------: | --------------------: |
|        24 |         214.1 ms |         6.5 ms |               3.11 MB |
|        48 |         441.3 ms |        13.1 ms |               6.22 MB |
|        96 |         879.8 ms |        25.9 ms |              12.44 MB |

The decoded pixel figures are retained-payload estimates, not whole-process memory measurements. They exclude cache framework and Python object overhead.

## Implementation

### Bounded immutable payloads

Classify, Dedup, and golden-suggestion thumbnails now receive encoded JPEG bytes directly. A process-local LRU retains at most 256 cutout payloads. Streamlit can render these bytes without recreating a media object from a cached PIL image.

The ROI editor keeps its inline data-URI behavior, with a separate 128-entry LRU. It no longer builds a three-level cached chain of cutout PIL image, square PIL image, and data URI.

Both representations are immutable, which avoids accidental mutation of a shared cached PIL object.

### Cache correctness and observability

The cache key continues to contain:

- Absolute frame path
- Frame modification time
- ROI name and complete normalized geometry
- Requested square size for ROI-editor data URIs

Performance diagnostics now report requests, hits, misses, and generation time for cutout thumbnails and ROI-editor data URIs. Cache occupancy and configured limits are also exposed to the benchmark and tests.

### Visible presentation work

Classify writes a temporary “Preparing N grid cards and thumbnails…” caption before card construction and removes it after the grid is ready. Page-size help recommends 24. Selecting 48 or 96 adds a concise explanation of the expected first-render cost.

Grid construction has its own `grid.presentation` timing span, nested under the existing Classify grid-render span.

## Before-and-after result

| Page size | Cold before | Cold after | Cold change | Warm before | Warm after | Warm reduction |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 24 | 214.1 ms | 205.9 ms | 3.9% faster | 6.5 ms | 1.1 ms | 82.8% |
| 48 | 441.3 ms | 456.0 ms | 3.3% slower | 13.1 ms | 2.3 ms | 82.6% |
| 96 | 879.8 ms | 882.6 ms | 0.3% slower | 25.9 ms | 4.1 ms | 84.1% |

| Page size | Decoded pixel estimate | Encoded cache payload | Payload reduction |
| ---: | ---: | ---: | ---: |
| 24 | 3.11 MB | 0.051 MB | 98.4% |
| 48 | 6.22 MB | 0.103 MB | 98.4% |
| 96 | 12.44 MB | 0.206 MB | 98.3% |

The output JPEG quality is 90. A regression fixture compares decoded output against the former resized PIL result and requires mean absolute channel error below 2 on a 0–255 scale.

Cold preparation is effectively unchanged: compression adds work while avoiding Streamlit's decoded-object cache serialization. The material latency improvement is on cache hits. Source files are pre-read before both paired variants so neither benefits from being second in the operating-system file cache.

## Streamlit grid measurement

A second temporary fixture used Streamlit's native application test harness with 96 scored frames. It measures the Python rerun and UI-delta construction, not the browser's layout and paint cost.

| Page size | Backend rerun and grid delta construction |
| ---: | ---: |
| 24 | 180.3 ms |
| 48 | 287.9 ms |
| 96 | 544.1 ms |

The roughly threefold increase from 24 to 96 supports the new guidance. The absolute backend time remains low enough that virtualization would add more interaction and fragment-state complexity than the current evidence warrants.

## Verification

Thirty-one automated tests pass. Phase 7 coverage verifies:

- Encoded output dimensions and perceptual fidelity
- Exact warm-cache reuse and observable request/hit/miss counters
- Separate bounded capacity for cutout and data-URI caches
- Eviction when the 256-entry cutout limit is exceeded
- Different ROI geometry produces a cache miss and a different crop
- Streamlit Classify refresh and grid construction accept encoded bytes
- Existing scoring, current-state, migration, progress, and snapshot behavior

Both benchmark scripts create temporary images, camera roots, and databases. They never access the configured production camera directory or database.

## Reproduction

```powershell
.\.venv\Scripts\python.exe scripts\benchmark_thumbnails.py
.\.venv\Scripts\python.exe scripts\benchmark_grid_render.py
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

## Next step

Phase 8 should first measure folder-ingest peak memory and identify where users currently lose progress visibility. If folder imports do preload complete file contents, replace that path with incremental scanning, hashing, and copying while preserving exact duplicate and filename behavior.
