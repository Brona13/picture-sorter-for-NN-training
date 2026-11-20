---
name: detector-thresholds-handover
description: Session 2026-11-20 (voice, no code) - per-target thresholds on the detector that decide found / not found, foreign-object filter (hand, paper, glove) as the first branch of step 1, risks, parked ideas
status: current
document_type: handover
session_date: 2026-11-20
base_version: v1.173.0
---

# Per-target thresholds in the detector (discussion, 2026-11-20, base v1.173.0)

**Nothing was built.** Voice conversation while driving; the user will say when code may be changed. Confidence tags: [Certain] = stated by the user or in the docs, [Likely] = inference, [Guessing] = gap-filling. Most of the "how it fits the code" part is [Likely]: the code was not read in this session, only `docs/current-project.md`.

## 1. Problem
- One picture with a **human hand** in it slipped into the data set. The two-object measurement (detect, Calculate, Evaluation) worked, but nothing stops foreign objects (hand, glove, sheet of paper over the part).
- A detector with only positive examples always returns its best guess. With no hand in the picture it still "finds" something. There is no notion of **absent**.

## 2. Decisions (user)
1. Introduce a **threshold into the detector**. The app has none that decides existence today [Certain: the only threshold is the review aid of v1.172.0, which flags and never changes the result].
2. **One threshold per target**, independent for each box. The threshold lives on the target, not on the detector.
3. **One detector, several targets**: hand, paper, and later the two part objects, each with several example crops. Each target is a separate output.
4. **Foreign target found = not good.** Everything else continues. (The user first said "whatever is not those objects falls into not-good"; he corrected it to this on confirmation.)
5. **Order in the Chain:** the foreign-object detector is the **first filter**. Pictures where a foreign target is found go to the not-good pile. The rest go on to the two-object measurement.
6. The not-good pile of foreign objects will be **very small and checked by eye** (user: "I always check the pile").
7. Many branches from one Ingest (three to five), each an "optic" that looks at the data set differently, ending in OK / NG buckets. **How disagreeing branches are combined is parked** ("we'll do that later").

## 3. What a threshold must mean
- Below threshold = **not found** for that target. It becomes a real output, not just a weak box.
- Two meanings, same mechanism:
  - **Foreign target (hand, paper):** high threshold. Only a confident hit counts. Found sends the picture to not-good.
  - **Part target (two objects):** lower threshold. A weak match means "needs a look", **not** "reject" (user agreed: a low score does not prove the picture is bad). Only no box at all blocks the measurement.
- Keep **unknown separate from bad**: a missing measurement is not a fail.

## 4. The uncomfortable part: will a score threshold work for hands? [Likely, not tested]
- The default detector is **template matching** (`cv2.matchTemplate`, normalised correlation). Its own limitation in `current-project.md`: it assumes constant size and appearance and does not cope with an object seen differently. **Hands, gloves and paper vary a lot**, so one correlation score is a weak "hand present" signal. High-scoring misses are likely.
- The **model** method (OWL-ViT) copes better with varied appearance, but its confidence is **relative to each frame's best box and not calibrated**, so a fixed threshold means little there.
- The user could not say how similar the hands look ("my eyes are not the embeddings").
- So the plan may need a different signal for this branch. Options, in the order I would try them [Guessing on which works best, nothing measured]:
  1. **Measure first:** run the current detector with hand examples on a batch that includes the known hand picture and look at the score spread. If the hand scores clearly above everything else, the threshold works and nothing else is needed.
  2. **Outlier view:** the Dedup Outliers tool (kNN isolation on ResNet embeddings) may surface hands and paper as isolated pictures without any examples. The user's own idea of a **second class of normal pictures** fits here.
  3. **Two-class decision:** examples of foreign objects plus examples of normal pictures, decided by nearest embedding. This is the "at least two classes" idea the user raised. It needs a new box type, not a detector threshold.

## 5. How it fits the code (v1.173.0) [Likely]
- Detections are stored per picture hash and target with `conf`; template matching stores peaks with the correlation as confidence. The threshold can be applied **when the result is read**, not when it is computed, so changing it needs no new run.
- But a threshold that decides existence **changes what flows downstream** (cascaded detectors, Calculate, Picture edits, Classifier anchors). It must therefore **make dependents stale** when it changes, unlike the review threshold, which never does. Decide whether it goes into `detection_signature`.
- Needs **new output dots** per target: *found* and *not found* as sets of pictures (as an Evaluation has Pass / Fail / All). Lines are typed (`lines.py`, `flow.edge_allowed`), so this needs a new line type or reuse of the "set of pictures" type. Not checked.
- A line to **not-good** has to end somewhere: the step-1 Classifier (class dot NG) or a Freeze NG input. Merge with any-logic is the natural place if several foreign targets exist.
- Open interaction: targets with **count 1 to 4** (several same elements, `name 1..N`). Is the threshold per box or per target? And "found" for a group: at least one box, or all?
- Open interaction: **cascade** (a detector searching inside another's box). A target that falls below the threshold must propagate as not found, not as a stale box.
- The existing review **Box values** (v1.172.0, match score with threshold, below is weak) is the closest existing piece. Candidate: promote it to a real threshold with a switch "flag only / decide".

## 6. Chain as the user imagines it
```text
Ingest
  -> Detector (targets: hand, paper; per-target threshold)
       found (any foreign target)  -> NG pile   (checked by eye)
       not found                   -> Detector (the two part objects) -> Calculate -> Evaluation -> ...
```
Other branches from the same Ingest (other optics) are possible later.

## 7. Risks
- Threshold too low: good pictures thrown out as hands. Start high, check the pile, lower step by step.
- Threshold too high: a hand slips into the measurement branch. The measurement review should catch it (a hand over the part wrecks the match scores), but that is a safety net, not the plan.
- Section 4: the signal itself may be weak for hands.

## 8. Parked (user said later)
- Merge rule when branches disagree. Direction mentioned: NG wins (any-fail), a missing measurement stays unknown, not fail.
- Scan depth dial, picture-level verdict from boxes, versions (earlier handovers).
- Threshold value for the model method (uncalibrated).
- Name of the new dots and where the not-good line ends.

## 9. Suggested first steps (when the user allows code)
1. Measure: run the detector with hand examples on a real batch and look at the score spread (no code, existing Detector page and its Box values view).
2. If separable: add the per-target threshold with found / not found dots.
3. If not: try the Outliers view on the same batch, then consider the two-class box.

## 10. Reminders from earlier handovers
- Nothing from v1.164.0 to v1.173.0 has been clicked through in a real browser.
- Short answers, no praise openers, one question at a time. He applies, commits and pushes patches himself.
