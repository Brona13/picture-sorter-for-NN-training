---
name: north-star-handover
document_type: handover
status: draft-for-later-session
created: 2026-10-20
related: current-project.md, data-model.md, methodology.md
description: Distant-goal vision for Picture Sorter, to check that changes fit the direction - not a work order
last_updated: 2026-10-20
---

# Picture Sorter: North-Star Direction (Handover)

Purpose of this document: carry the outcome of a long vision discussion into a later session. It is a **distant goal**, not a work order. Nothing here is to be coded now. When code changes are made, a session may use this document to check "does this change fit the direction?" and adjust if cheap to do so.

The user prefers **short sentences, one problem at a time**, and a direct tone without opening compliments. This document is detailed so that later sessions do not need to re-ask.

---

## 1. Summary

- The north star is **not a pivot**. It is a **tightening** of the existing tool into a more useful one.
- Guiding principle from the user: *whatever I set up by hand now (a relation between two modules, a rule, a threshold), is already a tiny step toward automating that part later.* Manual structure today = training wheels for automation tomorrow.
- Long-term job of the app: the **human-in-the-loop data engine for continuous retraining** of a camera-based vision classifier.
- The app still does **not** train the final classifier (see current-project.md, "Explicitly out of scope"). It prepares data for a separate training system.

## 2. Why automation (the motivation)

- The downstream (production) system keeps producing new pictures.
- Its detection quality is expected to be lower than desired at times.
- So pictures must be collected continuously and the neural network retrained. This is the general MLOps retraining loop used widely in the field.
- Labeling everything from scratch forever is not sustainable. The app should surface **the frames that matter** and reduce manual work over time.

## 3. The core loop (target behaviour)

1. Freeze a version (labels + goldens).
2. Ingest fresh frames from production.
3. Run them through the existing flow: scoring against current goldens.
4. The app flags what is **worth attention**: novel, uncertain, method-disagreeing, outlying frames.
5. The human labels only those, promotes a few to golden if useful.
6. Freeze a new version. Export for retraining.

"Worth labeling" should become an increasingly automated filter rather than a manual scan.

**Scan depth dial (idea, still open):** the user may want options for how extensive the scan of a camera project is, from a quick triage pass to a deeper full re-scan. Not designed yet.

Note: the user said details about **freezing versions** will come much later, because that area is "a mess for now". Do not design around versions yet.

## 4. Three entry flows, one shared engine

The user summarised three flows that overlap. All three should end up using the **same toolbox**.

| # | Flow | How data arrives | Status |
|---|------|------------------|--------|
| 1 | **Cold start** | Blank frames, no labels. Human works step by step: ROI, classify, goldens. Tools help the human check their own choices. | **Exists** (current app) |
| 2 | **Pre-labeled import** | New camera, frames imported with OK/NG labels from downstream. App audits those labels and suggests goldens mathematically. | **Future** |
| 3 | **Production feedback** | Existing, already-frozen camera receives a new batch from production. Should reuse the algorithms from flow 2 (and 1) to enhance the selection. | **Future** |

Agreed framing: all three are entry points into one engine, "score against goldens, flag what is interesting". They differ only in **how the dataset arrives**, not in what the app does afterwards.

The user wants flow 3 to **benefit from every algorithm created for flows 1 and 2**. Practical consequence for coding sessions: new analysis features should be written as reusable functions over "a set of frames in an ROI + an embedding", not tied to one flow.

## 5. Flow 2 in detail: import with labels

### 5.1 Import
- Create a new camera (already possible via the Overview "New camera" wizard).
- On the Ingest page, import pictures **together with a class label**. Idea from the user: two buttons on the Ingest page, one for importing OK pictures, one for importing NG pictures. (Exact UI is a detail for later.)
- Only the **class** matters (OK / NG). Downstream bounding-box positions are not imported as labels.
- Imported labels land as **normal labels, not golden**.

### 5.2 Terminology (the user asked for help here)
The app's vocabulary differs a little from the wider ML world:

- **Label** (app): a tag on a frame, OK or NG. No implied trust level.
- **Golden** (app): a trusted reference frame used for scoring. Specific to this app.
- **Pseudo-label** (ML world): a label produced by a deployed model, a noisy starting guess.
- **Verified ground truth** (ML world): a label a human has confirmed.

Proposed mapping: labels imported from downstream are **pseudo-labels** (one trust level below a human-confirmed label). Only human-confirmed ones should be promotable to golden. This was suggested by Claude and not explicitly decided. The user should confirm before any schema work. Note the app already stores `labels.via` (where a label was set); an "imported from downstream" source would fit that concept.

### 5.3 Problem: scoring needs goldens
Scoring compares against goldens. With imported labels but no goldens, nothing can be scored. Hand-picking goldens from a large imported set was judged by the user as "handwork" and, in embedding space, effectively **random and possibly misleading**.

### 5.4 Idea: mathematical golden selection per class (user's own idea)
Select goldens **per class**, separately for OK and NG:

- A few (1 to 3) frames **near the center** (centroid / medoid) of the class in embedding space = the "typical" goldens.
- Plus some **border cases** to add variety = the "edge" goldens.

Standard names for this (the user asked, and was pleased that they arrived at a known method independently):
- **Medoid / centroid selection** for the typical picks.
- **Boundary sampling** for edge picks. Related terms: active learning, support-vector-like points.
- Combined, it is a known pattern for reference-set selection. "Golden" is the app's own word, not a synonym of anything standard.

**Number of goldens:**
- The algorithm **suggests** a count based on the spread of the class (tight cluster = few; spread-out = more; plus boundary cases).
- The user keeps **controls to override** (add/remove goldens, slider or input) before committing.
- Suggestion first, human decides. This matches the app's philosophy that the human stays responsible.

### 5.5 Idea: class-separation check
After per-class selection, a **second calculation compares the two classes** against each other:
- Clean separation: labels look consistent, the embedding is doing its job.
- Heavy overlap: red flag. Either labels are noisy, the embedding does not capture what matters for this feature, or the classes truly look alike.

The user said overlap "would be good" to detect, meaning the detection is valuable (it exposes problems).

### 5.6 The ROI requirement
Calculations on the **whole frame would be incorrect**. They must run on the **ROI crop that matches what downstream actually looks at**. This fits the existing design (the ROI crop is what gets embedded). So the order is:
1. Import frames with labels.
2. Obtain the ROI (see 5.7).
3. Embed ROI crops.
4. Run per-class golden suggestion and class-separation check.

### 5.7 Idea: import a screenshot of the downstream labeling tool
- Ingest page option: import a **screenshot of the downstream labeling tool**, in which the downstream annotator has drawn the box.
- The app **detects the box in the screenshot automatically** and sets the ROI coordinates from it. No manual drawing.
- The user confirmed: automatic extraction, not just a visual reference.
- Claude's feasibility remark (unverified): if the downstream tool draws the box in a distinct colour or line style, plain image processing may be enough. A feasibility check is needed later.
- The screenshot may show a box for the OK state, for the NG state, for both, or for none.
- If a box is found, the app **auto-creates the ROI** and the **Chain** view shows a Detector box connected to Ingest with that rectangle already in place.

## 6. Anomaly detection (discussed at the end, not designed)

- Purpose: NG pictures are rare and varied. Instead of learning "bad", model only the "normal" (OK) distribution and flag whatever deviates.
- Works in both directions: finds real defects with no labeled examples, **and** finds garbage inside the OK pile (mislabeled frames, odd lighting, frames that do not belong) that may deserve deletion.
- The user sees it as a good way to hunt for NG candidates and for pictures to delete.
- Purpose-built industrial methods exist: **PatchCore** and **PaDiM**. They are not general embeddings. They model "normal" and flag distance from it. Worth evaluating later for exactly this use case.
- Caveat: these were mentioned from general knowledge. Nothing was benchmarked on the user's data.

## 7. Embedding choices

Current app methods: `cpu` (HSV histogram + MSE + SSIM), `resnet18`, `resnet50`.

- The user **decided to use ResNet-50** (plus ResNet-18 and the CPU family) **because the downstream system uses that network**. Keep this reason in mind: staying aligned with downstream is a deliberate choice.
- Other options the user asked about, for the notes (none chosen, none tested):
  - **CLIP**: image-text trained, more semantic similarity.
  - **DINO / DINOv2**: self-supervised ViTs, often strong for fine-grained visual similarity and used in anomaly detection pipelines.
  - **EfficientNet**: lighter and faster CNN alternative.
  - **PatchCore / PaDiM**: dedicated anomaly detection (see section 6).
- Existing invariant to respect: **never blend classical and ResNet scores into one hidden verdict** (current-project.md, out of scope). Any new method should be a separate opinion.

## 8. How this relates to what already exists

From current-project.md (state as of 2026-10-18, app v1.63.2). This mapping is Claude's reading, not something the user stated.

| North-star idea | Closest existing piece | Gap |
|---|---|---|
| Per-class golden suggestion by centroid + boundary | `suggest_goldens.py` (most-uncertain, diversity-spread suggestions) | Existing logic works from **already existing goldens and scores**; the new idea works with **no goldens**, from class geometry alone. Different algorithm, same UI slot (suggested goldens panel). |
| Class-separation check | `insights.py` (confusion matrices vs labels), `outliers.py` (kNN isolation score) | Nothing measures overlap between two labeled classes in embedding space yet. |
| Finding odd frames in a class | Outlier scoring (Dedup / Classify Outliers view), per-product outliers (open work 0b) | Existing: kNN isolation. Anomaly methods like PatchCore are a different family. |
| Import with labels | Ingest (`ingest.py`, Ingest page), `labels.via` | No class-aware import. No "pseudo-label" trust notion. |
| ROI from screenshot | ROI editor, Detector, Chain canvas | No image-based box extraction. |
| Auto-created Detector box off Ingest | Chain canvas (`chain.py`, boxes derived from `rois`) | Chain boxes are derived from ROI rows, so creating the ROI through the existing `PUT /rois` path should produce the box. Detector-box-bound-to-`vision.<feature>` is already listed as Chain "next steps". |
| New batch into frozen camera | Ingest + scoring + Versions + Verdicts | Works manually today. The "flag what matters" filter is the part to strengthen. |
| Scan depth dial | none | Not designed. |

Open-work items in current-project.md that relate: 0b (per-product outliers), 6 (coverage-aware / farthest-point selection to reduce redundancy), 5 (classical metric normalisation). Item 6 is close in spirit to the diversity part of golden suggestion.

## 9. Guidance for future coding sessions

When making a code change, briefly check:
1. Does it make a **manual relation or rule** explicit and stored as metadata? Good: that is a step toward automation.
2. Is the new logic **reusable** across the three flows (a function over frames in an ROI plus an embedding), or tied to one UI page?
3. Does it keep the **human in control**? Suggestions with override, never silent replacement of human labels.
4. Does it keep **ROI-crop-based** computation, never whole-frame?
5. Does it keep scoring methods as **separate opinions**?
6. Is derived data kept as **recomputable metadata**, as elsewhere in the app?

If a change does not fit, flag it and propose the smallest adjustment. Do not refactor for the north star alone.

## 10. Decided vs open

**Decided by the user**
- Direction is tightening, not pivoting.
- Motivation is the continuous retraining loop.
- Three flows share one engine.
- Per-class mathematical golden suggestion (centroid + boundary) is wanted.
- Count of goldens: algorithm suggests, user can override with controls.
- Computation must be on the ROI crop.
- Screenshot import with automatic box extraction is wanted.
- Detected box auto-creates the ROI and a Detector box off Ingest in the Chain.
- ResNet-50 chosen to match downstream.
- Not writing code for any of this now.

**Open / not discussed in detail**
- Scan depth dial: what the options are.
- Versions: deliberately postponed ("a mess for now").
- Pseudo-label trust level: Claude's proposal, needs confirmation.
- UI for labeled import (two buttons was a first thought).
- Whether the class-separation check is a number, a plot, or both.
- Whether to try DINOv2 / CLIP / PatchCore, and on what data.
- Feasibility of detecting the box in a screenshot (depends on the downstream tool's drawing style).
- How "worth labeling" combines signals (novelty, margin, method disagreement, outlier score, anomaly score) into one triage ordering without hiding a blended verdict.

## 11. Suggested next steps (when the user is ready)

None are scheduled. Candidates, from cheapest to biggest:
1. Prototype per-class medoid + boundary suggestion on an existing camera that already has OK/NG labels, and compare with the current `suggest_goldens.py` output.
2. Prototype the class-separation measure on the same camera.
3. Screenshot box detection feasibility with 2 or 3 real screenshots from the downstream tool.
4. Class-aware import on the Ingest page.
5. Anomaly method experiment (PatchCore-style) on one ROI, compared with the existing Outliers view.

## 12. Caveats

- Much of the app (v1.31.0 to v1.63.2) has only been tested with a mocked API, not in a browser on real data (current-project.md, open work 1). Real-data validation comes before building on top of it.
- Several statements about methods (PatchCore, DINOv2, CLIP) came from general knowledge in conversation and were not verified against the literature.
- The user also mentioned wanting some of these notes (embedding alternatives, anomaly detection) in handover documents for a later video session. This file can serve as that source.
