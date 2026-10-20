---
name: handover-2026-10-20-detector-outputs-and-module-types
document_type: handover
status: draft-for-next-session
created: 2026-10-20
related: current-project.md, session-handover-2026-10-20.md, north-star-handover.md, plans/crop-follows-detector.md
---

# Handover: detector reliability, detector outputs, module types

Discussion only. No code was written or changed. Everything below is a design direction or an expectation, not a measured result.

## 1. The problem

- The Chain detector with **rotation ticked** that looks for **two holes** is unreliable. The other (first) detector, rotation off, is fine.
- Symptom: on some pictures the findings of the two targets **overlap**, i.e. both targets lock onto the same hole.
- Reuse rectangle (v1.79.0) with more examples improved it a little, but the whole dataset was not detected 100% correctly.
- Method in use: exemplar (template) matching, rotation-aware search in the Chain. OWL-ViT is not involved.

## 2. Diagnosis

- Each target is matched independently, so nothing stops two targets from winning on the same spot. There is no rule yet that rejects a second target on an occupied hole.
- The two holes are identical. The only difference is an **L-shape under each hole, pointing in a different direction**. Current examples include the whole hole plus the whole L, so the hole dominates the crop and the two targets look nearly the same to the matcher.
- OWL-ViT would not help here: it tells things apart by overall look, its boxes are imprecise and it gives no angle. Not tested on these pictures; this is an expectation.

## 3. Things to try first (no new code)

1. Make each example **tight around the L plus a bit of hole**, so the L dominates the crop. The found centre then sits between hole and L, not on the hole.
2. Add a **second (cascaded) detector** that searches inside the first one's found box with an example of the **hole alone**. That gives the exact hole centre and the two holes can no longer land on one spot.
3. The first box may then be too small to contain the whole hole. The cascade's **padding** setting widens the parent box uniformly. It exists today, but the widened search area is **not drawn** on the page.

## 4. Decisions and ideas from the user

### 4.1 Own search rectangle instead of a uniform margin
- The user wants a **hand-placed search rectangle**, placed and sized where the second detector should look, not only a uniform padding.
- Closest existing piece: **Crop that follows a detector target** (v1.77.0). Draw the rectangle once, it keeps its place relative to the found target on every picture.
- Limit: that Crop is fixed size and **does not turn**. The parts are rotated, so the rectangle would drift. The fix is **Straighten** (phase 2 in `plans/crop-follows-detector.md`): turn the picture back by the target's angle around its centre, then cut the rectangle upright.

### 4.2 Detector outputs are ticked per target, consumed in the next box
- Today a detector stores centre, size and angle per found box, but downstream (Calculate, the target dots) sees **only the point**. The angle is not available as an output.
- Wanted: the user decides which outputs to use. Design agreed:
  - On the detector, **per target**, tick which outputs it offers (for example position, angle). Each target has its own ticks (left hole may offer position and angle, right hole only position).
  - The Chain keeps **one line per detector**. No extra dots per output, so the canvas does not get cluttered as outputs grow.
  - The **consuming box** reads the offered outputs and shows a **dropdown** for how to use them. Example in Crop: position only = stays upright; position plus angle = **Straighten**.
  - The same idea applies to Calculate: it could take an angle directly, not only two points.
- Relation to current code: the Chain currently draws one dot per target and an arrow from a dot carries the point (`point` on the flow edge, v1.74.0). The new design would replace or extend that with the ticked-outputs model. Not designed in detail.

### 4.3 Pre-processing before matching
- Idea: filter or blur both the examples and the pictures the same way so the match depends more on the overall shape (the L).
- Caveat: too much blur can wash out the L and make the holes look alike again. Needs a gentle setting.
- Filters exist today only on the old per-ROI Detector page (applied before its detection). The Chain detector does **not** have them yet.

### 4.4 Module types as a pattern (agreed, to be written into the project docs)
Every module declares its type, its inputs and its outputs. Connections follow from that.

| Type | In | Out | Examples |
|---|---|---|---|
| Picture step | picture | picture | Crop, Straighten, filter / blur, resize |
| Measuring | picture | numbers | Detector |
| Calculation | numbers | number | Calculate |
| Verdict | number(s) | verdict | Evaluation |

- A picture output only fits a picture input. Colour or group the boxes by type on the Chain so it stays readable as it grows.
- Open: whether filters and resize are separate boxes or one box with an ordered list of picture steps inside. The user did not decide this.
- Use this as the guardrail for every new module: declare type, input, output first.

## 5. Next features (proposed order, needs the user's confirmation)

1. **Per-target output ticks on the detector + consumer dropdown** (section 4.2), which enables Straighten.
2. **Straighten** in the Crop (phase 2 of `plans/crop-follows-detector.md`), driven by the angle output.
3. **Draw the padded / own search area** on the detector page so the margin is visible and adjustable.
4. Same-spot handling: today only highlighted in the findings grid (v1.78.0). Whether such pictures should also go on the detector's review list is still unanswered. A rule rejecting a second target on an occupied spot is possible but is the user's decision.
5. Filters / blur as a picture-step box for the Chain (section 4.3), within the module-type pattern.
6. Write the module-type rule (section 4.4) into the project docs (`CLAUDE.md` or `docs/`).

## 6. Open questions

- Pictures with two targets on the same spot: add to the review list automatically?
- Ticked outputs: how exactly do they replace the current per-target dots and the `point` on edges?
- Filters and resize: separate boxes or one box with an ordered step list?
- Padding: keep the uniform margin next to a hand-placed rectangle, or replace it?

## 7. Caveats

- Nothing here has been checked on real camera frames. Detector, cascade, following Crop and Reuse rectangle were tested on synthetic pictures and with a mocked API only (see `session-handover-2026-10-20.md`).
- The expectation that tight L-shaped examples will separate the two holes is untested.
- Working preference: short sentences, no opening compliments, one problem at a time. In voice or driving situations keep answers very short and do not ask whether to end the conversation.
