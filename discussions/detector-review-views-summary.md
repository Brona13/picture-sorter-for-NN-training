# Detector Review Views: Session Summary

Purpose: input for a planning session. Conceptual discussion only, no code was written.
Origin: voice conversation, conceptual level.

## 1. Problem

- The detector finds 1 or 2 objects per picture, each defined by cutout rectangles (examples).
- Results appear in a grid of thumbnails with colored boxes drawn at recalculated positions.
- Datasets hold thousands of pictures (roughly 1,000 to 4,000).
- Today the user scrolls thumbnails by eye to spot pictures where boxes moved unexpectedly (for example, orange usually on the left and blue on the right, then the behavior changes). This is too slow at that scale.
- Existing helpers: a filter for "only one found" and for "boxes crossing each other".

## 2. Goal

Surface the pictures that most need attention, so the user can pick a few and add more cutouts to the detector. A reference picture or reference point must not be required; the human eye does that job well, so the math should mimic it with density.

## 3. Core concept: density heat map (no reference)

- Collect the found box centers for one target across all pictures.
- Count how many fall into each cell of the picture area.
- Dense area = normal. Sparse cells = unusual.
- Clicking a spot lists the pictures behind it.
- Reuse the existing Evaluation module: its heat map, drag-to-zoom histogram and pass-band interaction. The new chart plots box position instead of a computed value.

## 4. Views (switchable on one chart area)

With one object:
1. Heat map of that object's position (works directly, no open questions).

With two objects, three views:
1. Target 1 position heat map.
2. Target 2 position heat map.
3. Relationship map: distance between the two box centers vs. angle of the line connecting them. One dot per picture, with normal pictures clustering tightly. It works under rotation because the relationship stays constant for a rigid part. Weakness: it shows that something is off, not which box slipped. The per-target maps cover that.

Defaults: relationship view when two targets exist, single heat map when one.
Design risk: too many switches slow down scanning, so keep the default simple.

User's reasoning: no single tool handles all pictures, so the tool should be as powerful as possible with several views.

## 5. Additional views considered

| View | What it catches | Cost |
|---|---|---|
| Angle map (if rotation is on) | Box turned oddly, e.g. symmetric feature confused | Cheap |
| Box size / aspect | Wrong match with a different footprint | Cheap |
| Match score as plain ranking | Weak matches in the right place | Cheap |
| Overlap of the two boxes | Both targets on the same spot | Mostly exists already as a filter |
| Cutout similarity (compare content under each box to the examples) | Box placed fine but content wrong (background, lighting) | Heavy, most powerful |

## 6. Sorting and attention score

- One combined "attention score" per picture, sorted highest first.
- Signals: distance from the dense area (heat map), low match score, and for two targets, distance of the pair relationship from the normal cluster.
- Missing targets go straight to the top.
- Show the individual signals per picture so the user sees why it ranked high.
- User can pick which signal to sort by.
- Decision: one default method, pre-calculated after each run. No reference choice needed. Keep signals separate underneath so a second sort is easy to add later. Add a method switch only if the default fails on real pictures.

## 7. Definition of "flagged" per method

- Heat map (one or two targets): the user sets an area counted as normal. Pictures outside it are flagged.
- Match score / success rate: a percentage threshold; below it is "not good".
- Relationship map: a zone around the cluster, same idea as the heat map.
- Pattern: each method has its own zone or threshold, and the counter is how many pictures fall outside it.
- Interaction: drag the band or zone on the chart and the counter updates live (same as the pass band in Evaluation).

## 8. Workflow (human in the loop)

1. Pick a view.
2. Select the odd pictures.
3. Add one or two more examples to the detector.
4. Rerun.
5. Watch the flagged count before and after, and stop when it stops dropping.

- A few rounds are enough.
- With thousands of pictures, a handful of stubborn failures can go to review or be deleted.

## 9. Deferred

- Drift over time (plot any signal against capture order). Not needed now because lighting is stable in the current data. It is cheap to add later, since it is the same signals on a time axis.
- Do now: keep the capture timestamp available per picture. File names already carry date and time.

## 10. Open questions for the planning session

- Should the two-target heat map also get a combined view (both targets in one chart, different colors)? Left undecided.
- Exact weights for combining signals into the attention score.
- Which of the five additional views ship first.
- How the zone / threshold per method is stored and shown.

## 11. Suggested build order (assistant's proposal, not a decision)

1. Per-target position heat map plus click-to-list pictures, reusing the Evaluation chart.
2. Zone/threshold definition with live flagged counter.
3. Relationship map for two targets.
4. Attention score and sorting, with visible signals.
5. Cheap extra views: match score, angle, box size.
6. Later: overlap view, cutout similarity, time drift.

Confidence: [Likely] that the density and relationship approach works for rigid parts. [Guessing] on score weighting and on the build order, to be validated on real data before investing further.
