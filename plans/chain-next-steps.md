---
name: chain-next-steps
description: Next steps for the Chain canvas after the Windows work (v1.66.4): edge routing, documentation of cascading, Tolerance leftovers, and the detector-anchored ROI (design still open)
status: items 1, 2, 4 done (v1.66.6); item 5 built as v1.67.0 with the recommended defaults (see below); item 3 is the user's
document_type: plan
last_updated: 2026-10-19
---

# Chain canvas: next steps

Source: `discussions/modules-chaining-canvas.md` (voice handover, 2026-10-19). Compared with the code at v1.66.4, part of it was already built.

## Already built (the discussion predates it)

- Detector box, cascading, Calculation = **Calculate**, Evaluation = **Tolerance** (v1.66.0-v1.66.4, `plans/detector-calc-chain.md`). Verdict storage: the freeze records `stats.rules.measurement`.
- **Every ROI has a paired Classify box** (discussion section 4): `chain.get_canvas` adds one per ROI, product-sorting or feature, both open the same Classify page; the palette has no standalone Classify button. Nothing to change; ROI and Classify keep their names.

## Cascade semantics (verified in `flow.run_detector`)

- A downstream detector searches, per target, only inside the box the upstream detector found for the **same target name**, widened by its `pad` setting.
- If upstream found no box for that target on a frame, the target is skipped for that frame; the frame is listed for review (and a human-placed box survives later runs).
- Rotation: the downstream search turns only when its `rotate` setting is on (default for a hole detail: off); the upstream box's own angle is stored but is not applied to the downstream search.
- The downstream detector must be run after the upstream one is fresh.

## Steps

1. **Edge routing (done, v1.66.5).** Arrows use React Flow's `smoothstep` type, so a line between vertically stacked boxes stays visible. Styling only.
2. **Documentation (done).** `current-project.md` records the cascade rules above and the smoothstep edges; the open-work list no longer asks for filter / detector boxes on the Chain.
3. **Real frames (user).** Calibrate the angle precision of Detector 1 / 2 on the ~160 pictures (expected 0.3-0.5 deg).
4. **Tolerance band (done, v1.66.6).** The histogram band is draggable: middle = nominal, edges = tolerance. Clicking a bar and the "Use as nominal" list button already set the nominal.
5. **Detector-anchored ROI (open, needs decisions).** An ROI drawn by hand on an exemplar picture follows a reference point from an upstream detector, per frame.
   - Needs: per-frame ROI geometry (an offset from the detector's centre, optionally with its angle) computed on read, never stored over the static rectangle; thumbnails, Classify and the scores must use the per-frame crop; arrow Detector -> ROI.
   - **Decisions needed before building:** (a) which detector target is the anchor (one named target per ROI?); (b) translation only, or also rotate the ROI with the detected angle; (c) what a frame without a detection does (review list, or fall back to the static rectangle); (d) ROI behind another ROI (parked until a scenario exists); (e) how cached scores and vectors are invalidated when the anchor moves.

## Tests

Vitest: Chain edges are smoothstep; `dragBand` maths and a drag of the band's edge saving the tolerance; existing chain and flow tests unchanged.

## Anchored ROI: what was built (v1.67.0, plan `~/.claude/plans/wiggly-foraging-koala.md`)

Steps 1-4 and 6 (overlay) as planned, with the recommended defaults: one anchor per ROI, translate-only unless *Follow rotation*, no fallback for pictures without a box. The anchor is set in the ROI box's panel (the arrow is derived and deletable), not drawn by hand. Left: the ROI editor itself does not yet show the anchor's box; "no anchor" badge and filter on Classify cards; real-frame check.
