# Detector thresholds and the foreign-object filter (plan, 2026-11-20)

Source: `discussions/session-handover-2026-11-20-detector-thresholds.md`. Base: v1.173.0. Status: **phase 1 built in v1.174.0** (the threshold decides, per target, with the tick under Box values); phases 2-3 (found / not found dots, the line to NG) not built; phase 0 (measuring on real pictures) and phase 4 are the user's. Confidence tags: [Certain] = user decision or read in the code, [Likely] = inference, [Guessing] = gap-filling.

## Goal

A picture with a hand, glove or sheet of paper over the part must not reach the two-object measurement. A detector with a threshold per target can say **found** or **not found**; a foreign target found sends the picture to the not-good pile. The pile is small and the user checks it by eye. [Certain]

## What exists and is reused (read in code, 2026-11-20)

- **Boxes with a score:** every stored box has `conf`; template matching stores the correlation as `conf` (`detections.py`, `flow.frame_boxes`). [Certain]
- **A threshold that only flags:** `review_values` per target slot, `score_min` and angle band (`flow.review_values`, `set_review_value`, v1.172.0). Not in `detection_signature`, never changes the result. This is the piece to promote. [Certain]
- **Detector outputs today:** `GIVES["detector"] = {PICTURE, POINT}`; a detector gives no set of pictures (`lines.py`). [Certain]
- **A box with pass / fail dots that pass pictures on:** Evaluation (`VERDICT_DOTS`, pass = OK, fail = NG, `lines.py`, `flow.py` ~1342-1406). A Classifier labels from such a dot, a Merge collects dots (any / all). The new dots copy this pattern. [Certain]
- **Review on the detector page:** `review_frames` (target with examples and no box), Show filter, needs-attention order. [Certain]

## Phase 0: measure (no code)

Use the existing Detector page and its Box values on a real batch that contains the known hand picture. Add hand examples to a target and look at the score spread.

- Hand clearly above everything else: continue with Phase 1.
- Not separable: go to Phase 5 first. [Likely: template matching is a weak "hand present" signal because hands, gloves and paper vary and it assumes constant appearance, `current-project.md`]
- The model method (OWL-ViT) is no fix for a fixed threshold: its confidence is relative to the frame's best box. [Certain]

## Phase 1: threshold decides, per target (small)

- Per target slot, `score_min` gets a switch **Flag only / Decides** (default: flag only, so nothing changes for existing chains).
- When it decides, a box with `conf` below `score_min` counts as **not found**. Stored boxes are untouched; the threshold is applied **when the result is read** (one helper next to `frame_boxes`), so changing it needs no new run. [Likely]
- Every reader goes through that helper: the strip and review counts, cascaded detectors, Calculate points, Picture edits, Classifier anchors. A below-threshold target must propagate as **not found**, never as a stale box. [Likely, to check in code: `_target_behind_dedup`, `calc_points`, `step_two_measures.py`]
- **Staleness:** a deciding threshold is not part of `detection_signature` (that would force a new run for no reason), but dependents must be marked stale when it changes. Needs a small "decision signature" that dependents include. [Guessing: how dependents record their inputs was not read]
- Part targets (the two objects) keep **Flag only**: a weak match means "needs a look", not reject; only no box blocks the measurement. Unknown stays separate from bad. [Certain]

## Phase 2: found / not found dots

- A detector gets frame-set outputs per target: **found** and **not found**, passing the pictures (muted and deleted ones never pass, as everywhere). `GIVES["detector"]` adds FRAMES; the edge check (`lines.edge_allowed`) accepts them into Classifier, Dedup, Merge and Detector inputs.
- Several targets (hand, paper): a **Merge (any)** of their *found* dots gives "any foreign object". No special code. [Likely]
- Count 1 to 4 targets (`name 1..N`): *found* = at least one box passes the threshold. Proposed default, to confirm. [Guessing]
- Cascade: a target searching inside another detector's box is *not found* when the upstream target is not found.

## Phase 3: not-good pile and first-filter order

- A *found* line ends in the step-1 Classifier's **NG** class dot or a Merge feeding it. The line means NG, like an Evaluation's fail (`flow.py` meaning of a line). The user draws every line himself; nothing is wired automatically. [Certain]
- Chain: `Ingest -> Detector (hand, paper)`; *found* -> NG pile (checked by eye); *not found* -> the two-object Detector -> Calculate -> Evaluation. [Certain]
- Other branches from the same Ingest stay possible later; how disagreeing branches combine is **parked** (direction mentioned: NG wins, a missing measurement stays unknown, not fail). [Certain]

## Phase 4: test on real pictures

Guided test on `drone` or the batch with the known hand: start with a high threshold, look at the NG pile, lower step by step. Nothing from v1.164.0 to v1.173.0 has been clicked through in a real browser, so the first session starts with a browser check of the v1.169.0-v1.173.0 detector review. [Certain]

## Phase 5: fallback if the score does not separate hands

In this order, each only if the previous fails [Guessing on the order]:

1. **Outliers** (existing Dedup Outliers, kNN isolation on ResNet embeddings) on the same batch: hands and paper may show up as isolated pictures without any examples.
2. **Two-class box** (foreign examples plus normal examples, decided by nearest embedding): a new box type, not a detector threshold. This is the user's "second class of normal pictures" idea.

## Open points

- Which dots and names exactly (*found / not found*, or a name that says "foreign")? Parked by the user.
- Count 1 to 4: *found* = at least one box. Confirm.
- Does the deciding threshold need its own staleness signature, or can dependents read the result live? Check the code before Phase 1.

## Risks

- Threshold too low: good pictures thrown out as hands. Start high, check the pile, lower step by step.
- Threshold too high: a hand slips into the measurement branch; the measurement review should catch it (a hand over the part wrecks the match scores), but that is a safety net, not the plan.
- The signal may be weak for hands (Phase 0 decides).
- Version bump and patch only with the first code phase; this file is docs only and rides along.
