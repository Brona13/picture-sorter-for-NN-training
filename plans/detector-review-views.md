# Detector review views (plan, 2026-11-18)

Source: `discussions/detector-review-views-summary.md`. Status: phase 1 agreed (review aid only, 2026-11-18) and built in v1.169.0; phase 2 built in v1.170.0 as the Calculate + Evaluation logic (the user's choice: same operations and charts); phases 3-4 not started.

## Goal

On a detector box page in the Chain, show the pictures whose found boxes are unusual, without a reference picture or point,
so the user can add a cutout or two, run again and watch the count of unusual pictures drop.

## What exists and is reused

- **Stored boxes:** every found box has `x, y` (centre), `angle`, `score`, `w, h`, `source` per picture and per target slot
  (`flow.frame_boxes`; the page already loads them for all pictures as `boxes`).
- **Chart:** `ZoneScatter` (dots or heat map, a circle / rectangle zone with a drag handle, green inside, red outside) and
  `density.ts` (`density2d`, `densestSpot`, `heatPixels`). Today it plots B's offset from A on the Evaluation page.
- **Review filter:** "only review" = pictures where a target with examples has no box (`flow.review_frames`).

No new module and no new box in the Chain: this is part of the detector box page.

## Phase 1: position map per target (v1.169.0, first build)

- A **Position** chart on the detector box page, beside the picture viewer. One target at a time; a switch picks the target
  (or target slot, e.g. "hole 1", "hole 2") when there are several.
- Each dot is that target's box centre on one picture, in the picture the detector works on (the whole picture, or the
  cut-out when a Picture edits box is above it, or the input detector's box for a cascade). The same coordinates the
  viewer already uses, so a dot and the box on the picture agree.
- Heat map / dots switch and smoothing as on the Evaluation page.
- **Zone:** "Use densest spot" puts a circle on the peak; drag its edge to resize; rectangle shape too (as Evaluation).
  Saved per target slot on the detector box (`review_zones`), **left out of the detector's signature**, so changing the
  zone never makes the run stale.
- **Counter:** "N outside the zone" (missing boxes counted separately, as today). Updates live while dragging.
- **Show filter** on the frame strip: All / Outside the zone / Not found. "Not found" replaces today's "only review".
- **Click on the chart:** the strip shows the pictures within a small radius of the click; a "Show all" clears it.
- The zone is a review aid only: it labels, mutes or blocks nothing downstream.
- Backend: storing `review_zones` and keeping it out of `signature()`. The positions themselves need no new endpoint.
- Shared code: `ZoneScatter` gets an "absolute" mode (picture coordinates, y down, picture extent) instead of a copy.

## Phase 2: pair map for two targets

- One dot per picture for the relation between two chosen targets. Normal pictures cluster tightly.
- **Open:** what to plot (see note below). Default view when the detector has two targets with examples.
- Same zone, counter, filter and click as phase 1.

Note: the discussion said distance vs. angle "works under rotation". Only the **distance** stays the same when the part
turns; the **angle** of the line turns with the part. Options: (a) B's offset from A (dx, dy), the chart Evaluation
already has; (b) distance vs. angle; (c) distance vs. the angle relative to the detector's own found angle (`angle` of
box A), which stays constant when the part turns and the detector finds that turn. Decide on real pictures.

## Phase 3: attention score

- Per picture, kept as separate signals: missing target (always first), outside a zone (how far, in zone radii),
  low match score.
- One default order "Needs attention first" on the strip, with the signals shown per picture (why it ranks high).
- Computed in the browser from the stored boxes (no run needed); a second order is easy to add because signals stay separate.
- Weights: start with missing > outside zone > low score as a plain order (no blending), adjust on real data.

## Phase 4: cheap extra views

Match score (histogram with a threshold band, the Evaluation tolerance chart), box angle (when rotation is on), box size /
aspect. Each with its own band and counter, same pattern.

## Later / deferred

Overlap view (mostly exists as a filter), cutout similarity (heavy), drift over capture time (keep the timestamp available).

## Open questions (one at a time with the user)

1. Is the zone a review aid only, or should "outside the zone" also do something downstream (mute, or a verdict)?
   Recommendation: review aid only.
2. Two-target heat map in one chart with two colours? Recommendation: no, the switch is enough for phase 1.
3. Phase 2 plot (a / b / c above). Recommendation: decide after phase 1 on the drone pictures.
4. Which extra views ship first. Recommendation: match score.

## Checks per phase

Backend tests: `review_zones` saved, survives reload, does not change the signature or status. Frontend tests: the chart
draws one dot per picture with a box, the counter matches the zone, the filter lists exactly the outside pictures, the
click narrows the strip, the target switch changes the dots. Not clicked through in a browser: say so and give a two-line check.
