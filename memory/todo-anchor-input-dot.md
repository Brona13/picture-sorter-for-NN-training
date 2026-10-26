---
name: todo-anchor-input-dot
session_date: 2026-10-26
description: TODO - a separate anchor input dot on Classifiers (detector position vs. product frames), plus the remaining Chain line gaps; discussion unfinished
metadata:
  type: project
---

**Open TODO (discussion paused by user 2026-10-26, continue on another computer).** Nothing below is built yet.

## Problem
Chain: Ingest -> Detector -> Product Classifier -> Feature Classifier (limited to one product). A Feature Classifier needs two different things:
1. **Which pictures** - frames from the Product Classifier's class dot (a frames line).
2. **Where on each picture** its ROI sits - the box of a detector target (a position line, the anchor).

Both arrive at the same input dot, so the detector -> Feature anchor line looks like it replaces / skips the Product Classifier and the chain reads illogically. The computation itself is fine. The Anchor panel (`app/frontend/src/chain/AnchorSection.tsx`) also lists every detector of the camera, wherever it sits.

## Proposal (agreed in principle, not confirmed)
- Give a Classifier a **second, separate input dot "anchor"**. It takes a detector **target dot** (type POINT, "a target point" in `lines.py`): point output -> point input, consistent with the rule "any output connects to any input of the same kind". The main input keeps taking frames / pictures.
- Draw the anchor line **dashed and in another colour**, so Detector -> Product -> Feature stays the visible main flow.
- The Anchor panel offers only detectors **upstream of the box** (any path); none on side branches or after it. Under this rule the detector behind the Product Classifier is offered.
- Same dot on the Product Classifier (anchor / Picture edits input allowed since v1.104.2).
- No change to how anchors are stored or computed (`anchor.py`, setting `roi.anchor.<feature>`). Touches: `chain.py` edges, `lines.py` (add POINT to the ROI's TAKES), `chainModel.ts` `flowConnect`, `ChainView.tsx` node handles, `AnchorSection.tsx`.

**Open question:** should the anchor dot sit on the left under the main input dot, or on the bottom edge?
Alternatives that were offered: A) offer only a detector directly in front of the box (then a Feature Classifier fed by a product dot would have no Anchor section); B) offer every upstream detector (looser, still shows the jump line).

## Other Chain line gaps found (UI refuses lines the type table allows)
1. Detector **main dot** (picture) -> Picture edits, Dedup or Classifier: only target dots are accepted there.
2. **Dedup** -> Picture edits, detector or Dedup: "not made yet" (also in `flow.edge_allowed`).
3. **Feature Classifier dots (OK / NG)** -> another Classifier: refused ("do not feed another box yet"); needs a rule for what a class dot means as a frame set (scope is stored as a products list).
4. **Classifier picture output -> another Classifier's picture input**: no slot exists (picture input only for Picture edits boxes and detector targets).

## Already done this session (all uncommitted at the time of writing)
- v1.104.2: Product Classifier accepts a Picture edits input and a detector anchor; switching to Product mode keeps them; no Ingest line when it has an input.
- v1.104.3: Classify page Scatter / Outliers work again (`dedup_api.require_embeddable` accepts a Classifier as well as a Dedup box).
- v1.104.4: ROI editor offers only the pictures of the Classifier's products (`GET /frames?feature=`), with Previous / Next buttons. The user's remark "dropped down 4 pictures" was not understood; ask what was meant.

Related: [[user-voice-dictation]].
