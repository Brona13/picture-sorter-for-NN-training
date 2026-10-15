---
name: handover-new-tools
description: Six tools built from the voice handover (v1.15.0-v1.20.0) plus the integration of the laptop's Overview patches; what is verified, what is not, and the open points
session_date: 2026-10-15
last_updated: 2026-10-15
status: current
document_type: session-note
metadata:
  type: project
---

# Handover tools, v1.15.0-v1.20.0 (2026-10-15)

Source: [[discussions/picture-sorter-handover]] (a voice discussion, analysed against the code first: 8 clashes resolved, see that note's status section). Plan: `plans/handover-new-tools-plan.md` (all six phases done). Earlier the same day: ROCm/GPU work, see [[gpu-backends-rocm]].

## What was built
| Version | What | Notes |
|---|---|---|
| 1.12.0-1.14.1 | **Overview page**, detector model-download confirmation, stale-dedup fix, faster UMAP scatter, picture-size sliders | Made on the Windows laptop by another Claude session; arrived as patch files and was applied with `git am` |
| 1.15.0 | **Outliers** in Dedup: mean cosine distance to the k nearest frames, most isolated first, scatter colouring | derived on demand, nothing stored |
| 1.16.0 | **Find similar** on a Classify card: unlabeled frames nearest to a labeled seed, distance slider, tick, apply the seed's label | server re-checks each frame; never creates goldens; separate from the golden-based Bulk/Auto-assign |
| 1.17.0 | **Edge-angle rule**: line + band, angle 0-180 and direction (brighter side, not click order), pass/fail, Classify badge and Show filters | own opinion, never blended; settings/results in `settings` |
| 1.18.0 | **Augmentation ranges**: object shift (and optional rotation) against a reference frame, suggested central N%, editable ranges | measure and record only, no image is changed |
| 1.19.0 | **Downstream results**: metric/value/day/note per version, comparison table (schema v7, `version_results`) | metrics are free text because the downstream system's metrics are still unknown |
| 1.20.0 | **Pipeline stages** on Overview cards plus a step bar on the ROI pages; shared "current ROI" | derived from stored state only |

## Decisions (user)
- Cross-camera features are out of scope: the tool only analyses pictures.
- Integration order: the laptop patches first, my three commits replayed on top and renumbered (1.15-1.17); later phases continued from there.
- Augmentation ranges are recorded in the frozen version's statistics only; exports keep their documented no-manifest layout.
- Phase 6 extended Overview instead of Status.
- Outliers/edge/augmentation never feed into scoring; downstream results are records only.

## Bugs found while building (worth remembering)
- `cv2.phaseCorrelate` multiplies its inputs by the window **in place** when they need no padding; a reference reused for every frame degrades. Always pass copies (regression test in `test_motion.py`).
- Phase correlation is biased when a frame is also rotated (8 px off on a 1600 px crop); template shifts are refined with ECC seeded from it. ECC from zero fails on large shifts. ECC's correlation separates real matches (0.96+) from unrelated images (0.23-) only on clean inputs.
- `git apply` run from a subfolder silently applies only to that subtree ("0 files changed"); run it from the repo root.

## Not verified (test tomorrow, on real data)
Nothing from 1.15-1.20 has been opened in a browser or run on the real cameras; all checks used synthetic images and mocked APIs (307 backend and 177 frontend tests pass). In particular:
- Edge angle: the strongest-edge-per-slice rule may jump between parallel edges in a wide band; narrow the band. Verify the angle on a real frame.
- Augmentation: the "not measured" thresholds (phase peak 0.25, ECC 0.6) were calibrated on synthetic textures; the page shows how many frames fell out.
- Find similar and Outliers on real embeddings with masks/filters.
- Overview stage chips and the step bar with real products (product-owned ROIs select their product when a chip is clicked).
- Downstream results form (and what metrics the downstream system really reports).

## Open / next
- `setup_torch.sh`/`.ps1` hardware detect-or-ask helper (planned in [[gpu-backends-rocm]]); flaky `test_clean_schema.py::MigrationV3ToV4Tests::test_parallel_first_connects_all_succeed`.
- Embedding drift over time: filenames carry `dd.mm.yyyy_hh.mm.ss`, not parsed yet.
- Tab/branching UI reorganization, other rule tools (counting, presence, colour, area): deferred.
- Which machine's project folder is not a git repo (handover TODO) is unanswered.

## Git state and cautions
- `main` was 11 commits ahead of `origin/main` (`7cab281`) and unpushed at the end of the day; the user pushes themselves.
- The laptop may hold the four Overview patches as local commits: after the push there, `git pull --rebase` (identical content is skipped). Never `reset --hard` there without checking for unpushed work.
- Schema is now **v7** (one additive table). Back up `data/` before the first launch on real data, and do not copy a v7 database to a machine with older code (it would suggest `reset_database.py`).
