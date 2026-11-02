---
name: dedup-view-and-indicator
description: Plan for a view choice in the Dedup box (whole picture, crops and found boxes found going up its own tree) and a change indicator in the side panel; decisions of 2026-11-02; view list built in v1.138.0, indicator still open
status: v1.138.0 (view list) built 2026-11-02; v1.139.0 (indicator) not built yet
document_type: plan
last_updated: 2026-11-02
---

# Dedup view choice and change indicator

## Why

A Dedup box fed by an Evaluation pass/fail dot (or a Classifier dot) carries only a set of pictures, so it sees the whole picture. Broňa wants to choose what Dedup looks at: the whole picture, a crop, or a found box.

## Decisions

1. **What is offered.** Whole picture, plus every crop and found box found going UP the Dedup's own tree toward Ingest. Never another branch. For Dedup 2 (after Evaluation 1) this includes both inputs of Calculate: found boxes `hole-left` and `hole-right`, crops of Picture edits 2 and 3, `center-and-holes` of Detector 1, and the crop of Picture edits 1.
2. **Dedup boxes provide no view.** They are not listed. A Dedup after a Dedup inherits the upstream view.
3. **Only crops and found boxes.** Filters and masks are not views.
4. **Pixels for a chosen view.** Original pixels of the chosen area, no filters, no masks. Existing line-defined behaviour (for example Dedup reading a Picture edits box with filters) stays as it is.
5. **Crops with an angle.** All crops are listed individually. Where the angle is used (straightening crop), the straightened picture is the view. Found boxes with an angle are cut upright (straightened cut) in the new view choice. A Dedup fed directly by a detector target dot keeps its current axis-aligned behaviour.
6. **Pictures with no such view do not pass.** They are not muted, simply not in the set. Dedup only filters, it never labels or changes pictures. Show a count of pictures without a view.
7. **Line vs list.** When the line into the Dedup already carries a view (Picture edits line, detector target dot), the line decides and the list is read-only. The list is active only when the line carries just a set (Evaluation pass/fail dot, Classifier dot).
8. **Mutes.** Each Dedup keeps ONE set of mutes. Changing the view while mutes exist shows a warning overlay saying how many mutes will be lost, with Confirm and Cancel (reuse an existing confirmation pattern if there is one). On confirm, mutes and cluster results are cleared. No dialog when there are no mutes.
9. **Indicator.** Top right corner of the right side panel when in a module's details (Chain panel, "Selected box" row; free space in that corner still to be checked). It flags VIEW changes and SET changes individually and names what changed, for example "Detector 2 was run again", "Evaluation 1 tolerance changed", "Dedup 1 muted pictures". Idea: Dedup stores a fingerprint of each upstream box when it calculates and compares on open.

## Delivery

- **v1.138.0**: view list in the Dedup panel, upright/straightened cutting, no-view pictures not passing, overlay when switching view with mutes present.
- **v1.139.0**: the indicator, Dedup only.

## Open checks before coding

- How Dedup resolves its picture today (`dedup_box.py`, `dedup_api`, `anchor.py`, thumbs).
- How to enumerate ancestors up the tree, including both inputs of Calculate.
- Effect on embeddings cache keys, clusters/scatter, mutes clearing.
- Existing confirmation overlay to reuse.

## Notes for later

- **Indicator for other modules** (detectors, Picture edits, Calculate, Evaluation, Classifier): reuse the same corner and wording. Detectors already have `flow.status` (none/fresh/stale); the others compute live and would need a fingerprint.
- **"List can override the line"**: let the Dedup list override the view carried by the line. Not now; the line decides for the time being.
- **Multi-element detector targets** (count 2 to 4, "hole 1..N") are left out of the view list for now. Dedup would need per-box samples, like the Classifier.
