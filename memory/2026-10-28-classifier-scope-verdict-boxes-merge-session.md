---
name: classifier-scope-verdict-boxes-merge-session
description: Session 2026-10-27/28 (v1.120.0-v1.124.0) - Classifier follows its input line, Verdict draws boxes and keeps decided cards, Chain look (blue Classifier, corner icons, counters), Merge box; decisions, open items
status: current
document_type: memory
session_date: 2026-10-28
---

# Session 2026-10-27/28: line = handover, Verdict boxes, Chain look, Merge (v1.120.0 - v1.124.0)

One commit `5ae9e95` and one patch `picture-sorter-v1.124.0.patch` (home Linux, no dist zip). Details per version: `docs/current-project.md`. Checked in a headless Chrome screenshot, not with a real mouse drag.

## Rules agreed
- **A line into a Classifier hands over exactly the pictures the box on the other end passes on** (`datamodel._input_scope`, `frames_for_feature`). Cause of the "508 instead of 65" and empty grid: the frame set ignored the feeding line; thumbnails were blank for pictures without a detector box. A box with no input line passes no pictures.
- **Verdict** draws the boxes of Classifiers that labelled the picture (OK green, NG red; unlabeled / no found box skipped, no grey boxes). A decided card stays in place, dimmed, until Refresh (so sweep-painting works).
- **Chain look:** Classifier blue (hue 225; magenta rejected, too close to the purple Detector), Picture edits as narrow as Ingest (170), kind icon in each box's top-right corner (shared `kindIcons.tsx`), icons + numbers (`Counter.tsx`) instead of text. The detector's top-right dot is its main output handle, not a status dot.
- **Export** shows `☆ N` pictures skipped because they are not golden (`goldens_only` default on) - that explained "Export shows 0".
- **Merge box** (`merge:N`): combines same-meaning lines into one. Meaning comes from the first line (class name, Evaluation pass = OK, fail = NG), a line with another meaning is refused with a reason, removing all lines makes it neutral again (icon grey / green / red). Switch any (union) / all (intersection). Export accepts `{from: merge:N}`; Export still intersects its own lines, so Merge is how disjoint-product lanes combine.

## Open items
- Counters like `○ 4 🗑 4` on fed Classifiers: the deleted pictures are kept in every fed Classifier's set; not changed yet.
- Merge refuses `all` dots and whole-box outputs; `lines.TAKES['roi']` lacks POINT.
- `ClassifyView.test.tsx` / `ChainPalette` failed once each in a parallel run (ResizeObserver, flaky), passed on rerun; not investigated.
- User's real-browser check of Merge dragging, Verdict painting and the Chain look is open.
