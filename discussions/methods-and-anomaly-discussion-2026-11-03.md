---
name: methods-and-anomaly-discussion
description: Conceptual discussion 2026-11-03 (base v1.139.5) - which methods may serve step 1 and step 2, anomaly detection (PatchCore / PaDiM), DINOv2, other industry methods, and the question of importing labeled datasets into downstream. Discussion only, no code changed.
status: draft-for-later-session
document_type: discussion-handover
session_date: 2026-11-03
related: current-project.md, north-star-handover.md, session-handover-2026-11-02-two-step-solution.md
---

# Methods and anomaly: helicopter-view discussion (2026-11-03)

**Nothing here is built or decided as a work order.** It is a map of ideas to pick from later. The user wants to come back, read it, and choose the next valuable improvement of the app.

Confidence tags: [Certain] hard evidence, [Likely] strong inference from general knowledge, [Guessing] filling gaps. Nothing below was measured on the user's pictures or on his 4 GB card (RTX A2000).

## 1. Context
- The app is split in two steps. **Step 1:** decide OK or NG with several methods (Chain: detectors, Calculate, Evaluation). **Step 2:** choose which pictures go downstream, through the Box module.
- Only ResNet-50 is switched on in the configuration now. CPU and ResNet-18 are unticked. It was kept because downstream uses ResNet.

## 2. Step 2 and the ResNet match
- If downstream starts from stock pretrained ResNet, selecting with the same stock ResNet is a good proxy for round one. [Likely]
- From round two, downstream weights drift away from the stock ones. The match erodes with every retraining. [Likely]
- The user's idea: download each retrained model from downstream and import it into the app as the embedding, so rounds 2, 3, 4 stay aligned. **This idea was not found in the notes shown in this chat.** The assistant took the user's word for it. Check `memory/` and `discussions/` before planning it.
- The crop matters as much as the network. Downstream sees the rectangle, so selection must embed the same crop (the Box module does this). [Likely]

## 3. Step 1 is open to any method
- Step 1 only has to produce trustworthy OK and NG labels. Nothing downstream depends on how they were produced. [Certain]
- Condition: the result must be checkable against a human eye. Step 1 is the ground truth.
- New methods stay **separate opinions**, never blended into one hidden verdict (existing invariant).
- The user's toolbox view (scatter, outliers, others; no single method fits all pictures; combine what helps) matches common practice. [Likely]

## 4. Anomaly detection (PatchCore / PaDiM)
**Idea in simple words**
- Today (golden method): ResNet writes one fingerprint per whole picture. A new picture is compared with the OK and NG goldens. Question asked: *which example does it resemble?* Needs both OK and NG examples.
- Anomaly: the picture is cut into many small squares. Each square gets its own small fingerprint. All squares of all trusted OK pictures go into one memory bank. A new picture is scored by its worst square: if no normal square looks like it, it is flagged. Question asked: *does any part look unlike everything normal I have seen?*
- No training in the usual sense. The bank is stored data, not a new model. Output can include a heat map showing where the odd spot is.

**Why it fits the app**
- NG is rare and varied, so modelling only OK suits it. [Likely]
- Reusable in every round: build the bank from trusted OK pictures once, then run each new batch through it and look at what it flags. Works in step 1 and in later rounds.
- Also points at garbage inside the OK pile (mislabeled, odd lighting, frames to delete).
- Should stay a pointer like Outliers: it ranks pictures, the human decides.

**Conditions and risks**
- Needs many trusted OK pictures. A few hidden NG pictures in the bank teach it that defects are normal. [Likely]
- Assumes the part looks the same and sits in the same place. Run it on the **found box, straightened**, not the whole picture. The Chain already prepares this. [Likely]
- Uses the ResNet-50 already in the app, read at middle layers in small squares. No new model import needed. [Likely]
- Memory: fits a 4 GB card as far as known. The bank can be subsampled and searched on the CPU. Unverified on the A2000. [Likely]

## 5. DINOv2 as a possible stronger lens
- ResNet was taught to name things, so it can overlook small differences that keep the name. DINOv2 was taught without names to match views of the same thing, so it tends to keep fine detail. [Likely]
- Bigger and slower. On 4 GB only the smallest versions are realistic. It would be a separate import and is optional.
- Free to try in step 1 (no alignment cost there). In step 2 the alignment with downstream still argues for ResNet or the imported downstream model. [Likely]
- Not measured on the user's pictures. A small test on one camera would settle it.

## 6. Other methods engineers use (a map, not a recommendation)
1. Rule-based machine vision: edges, angles, distances, blob area, presence in a zone. **Already in the app.**
2. Template / pattern matching. **Already in the app (detector).**
3. Supervised detection and classification (YOLO-style). This is the downstream world.
4. **Segmentation**: colours exactly the defect pixels. Heavier to label, precise for scratches and cracks. Suggested as the best next one to look at, since it complements the box view. [Guessing]
5. Anomaly detection (section 4).
6. Few-shot and foundation models (DINOv2, segment-anything style) for a start with few labels.
7. Lighting and optics: often beats any model. Not software.

## 7. Downstream label import (open, not built)
- The user may be able to import labeled datasets into downstream. This would change a constraint from the earlier handover (downstream could not import labels or boxes).
- If true: the Box output could be exported with the picture in a readable format. The hand-drawing cost per picture drops. The step-2 goal shifts from "as few pictures as possible" to "the most varied set". Similar pictures still add little and slow each round, so selection still matters. [Likely]
- **Today's constraint stands** until the app is extended and the format is known.
- To find the format: ask the downstream developer (low chance of an answer), or export a tiny dataset from downstream and give it to Claude in the text chat. Make it small but varied: a few pictures, two classes, at least one picture with two boxes, one without a box. The files show the format (COCO, YOLO, custom), not the network behind it.

## 8. Candidate improvements to choose from later
| Candidate | Cost guess | Needs first |
|---|---|---|
| Anomaly (PatchCore-style) on one found-box ROI, compared with the Outliers view | medium | a camera with many trusted OK pictures |
| DINOv2-small as a second embedding opinion in step 1 | small to medium | check VRAM on the A2000 |
| Segmentation as a new lens | large | decide the labeling effort |
| Importing the retrained downstream model as the embedding | medium | confirm model format and that the notes hold this idea |
| Box export in downstream's dataset format | medium | the sample export from downstream |

## 9. Open
- Downstream's import format (section 7).
- Whether to test anomaly or DINOv2 on one camera.
- The earlier open item still stands: what NG means physically (part rotated beyond tolerance, or holes shifted), asked twice in the 2026-11-02 session and not answered.
- No detail work was started. The user wanted to stay at the helicopter view.

## 10. Working with this user
Short sentences, simple words when learning something new, no praise openers, lead with the deciding point. No code until he says so.
