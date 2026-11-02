---
name: two-step-solution-handover
description: Session 2026-11-02 (on top of v1.139.5) - the two-step solution (step 1 = clean and decide OK/NG, step 2 = choose pictures through the downstream box); what the user decided, how it fits the code, open decisions, items in between. Discussion only, no code changed for it.
status: built (see memory/2026-11-02-two-step-solution-session.md)
document_type: memory
session_date: 2026-11-02
---

# Two-step solution (discussion, 2026-11-02, base v1.139.5)

**Built later the same day (v1.140.0 to v1.147.0, see `memory/2026-11-02-two-step-solution-session.md` and `plans/two-step-solution.md`); this file is the idea as agreed before building.** At the time of writing nothing was built and the user said "no code change until I tell you". This file is the agreed idea plus how it maps onto the code, so the next session can start the plan `.md` and then code. Authoritative state of the app: `docs/current-project.md` (entries v1.138.0 to v1.139.5).

## 1. Why it came up (the user's downstream system)
- Downstream is a **ResNet-based detector** on whole pictures. He draws **one upright rectangle per picture by hand** (no rotated boxes) and gives it a class, usually OK or NG. The tool's OK/NG labels are applied identically there.
- Downstream **cannot import labels or pre-made boxes**. Export writes whole original pictures into OK and NG folders; nothing else is read by downstream.
- He wants the **least number of pictures necessary** per round and will add more in later rounds. Parts can **rotate by more than a little**; the part itself is always the same (rigid), only its pose changes.
- Step-one Chain boxes (detectors, Calculate, Evaluation) exist only to decide OK/NG precisely. They are **not** the downstream rectangle.
- Consequence he saw: picking goldens by whole-picture similarity does not match what downstream learns from (the object inside its upright box). Picking must look at pictures the way downstream's rectangle does.

## 2. What was decided (his words, in order)
1. **Two main steps, cleanly cut apart.**
   - **Step 1:** filter, hide, delete, and decide OK or NG for every picture (today's Chain up to Evaluation). Output: two trusted sets, OK and NG. "Quality computed, decided."
   - **Step 2:** choose which pictures go downstream, working on the two finished sets.
2. **Hand-over between the steps is labels only** (OK/NG per picture). The measured angle stays behind; step 2 never asks "is this OK?", only "is this worth labeling?".
3. **Step 2 starts like Ingest starts step 1**, but with two piles: an OK ingest (green) and an NG ingest (red).
4. **UI:** two tabs at the top, one canvas each. The **step-2 tab appears only when the closing module of step 1 exists** (replaces today's Export module). The palette changes per step (step 2 shows only step-2 modules). If step 1 changes afterwards: **a warning**, the tab stays.
5. **Step-2 modules so far:** Ingest OK / Ingest NG, **Box**, Classifier (as today, but fed by the Box), Export.
6. **Box module (new).** Lists the **detector boxes of step 1** (he judged nothing else useful: Calculate and Evaluation give numbers, Picture edits give crops). He clicks one; it is drawn on the example picture because the system knows where it was found; he drags it like any rectangle; the right pane shows **four numbers (left, right, up, down)** that he can read or type. The result is **one upright rectangle per picture** for **all** pictures, OK and NG (no shared box for OK).
   - **Two-box case first (his real scenario):** left hole sets the left edge (+ pixels left), right hole sets the right edge (+ pixels right), up and down are measured from both holes in the **part's own direction** (they turn with the angle). The turned rectangle is squared off into the smallest upright rectangle around it (bigger for tilted parts, background in the corners, like drawing by hand).
   - **One-box option comes after** (one detector box plus four margins). Three boxes: not planned.
   - He does **not** want the step-one boxes (measurement tools) mixed up with this downstream box.
7. **Classifier in step 2** works as today (scoring, goldens, clusters, outliers) but on the **Box rectangle**; labels already exist, it only helps choose goldens (the small set).
8. **Export in step 2:** the OK/NG folders with originals, **plus the box numbers per picture** (he types or draws them downstream). He also wants the numbers visible next to each picture.
9. A **varying box size is fine** for the detector (the box is its training target; a consistent rule matters, not a constant size). To be tested on a small batch downstream, especially very elongated boxes at steep angles.

## 3. How it fits the code (v1.139.5) - one recommended way
All of this is [Likely], from reading the code, not from building it.

- **Closing module of step 1 = the existing Export box with "Only goldens" off.** It already freezes the two sets as a project version (`export_box.freeze` -> `versions.insert_project_version`, items = frame, hash, class), and its `state()` already says when the Chain would now pick other pictures than the last freeze (`changed`). That is the "warning when step 1 changed". It also stores the whole graph in `stats.export.graph`. So the doorway is mostly a rename and a step flag.
- **Step-2 Ingest OK / NG = read the frozen version's items by class.** New root kind(s); everything after reads the picture list like Ingest does.
- **One graph, a `step` per box.** `flow.graph` is one setting per camera (`GRAPH_KEY`, `load_graph`/`save_graph`, `KINDS` in `flow.py`). The Box module must read step-1 detector results, so the simplest way is to keep one graph and let the tabs show the boxes of one step (layout in `chain.canvas`). A second graph would need cross-graph references.
- **Box = a derived detector.** Stored detector results are `{x, y, angle, score, w, h, source}` per picture hash and target (`flow.load_stored`/`_store`). If the Box module writes results in that same format (one target `box`, `angle` 0, computed `x, y, w, h`), then the Classifier anchor (`anchor.py`), Dedup view (`dedup_view.py`), `flow.node_frames`, `Finder` and cutouts work **unchanged**, and `dedup_view._upright` is a no-op for it. Cost: about 15 places test for the kind `"detector"` (12 in `flow.py`, 1 each in `anchor.py`, `dedup_view.py`, `chain.py`) and need to accept the new mode/kind; its signature (margins plus the signatures of the two source targets) gives fresh/stale for free.
- **Geometry to reuse:** `flow.calc_boxes(camera, calc_id)` already returns the two hole boxes **on the whole picture** (moved by the crops above each detector, angle added), and the direction between the holes is what Calculate measures. The Box module needs the same two points without needing a Calculate box (a point picker on two detector targets).
- **Rectangle math:** u = unit vector left hole -> right hole, v = its normal; corners = (left hole - L*u, right hole + R*u) +- (U or D)*v; the upright box is the min/max of the four corners. Needs `margin from hole centre or hole edge` decided (see 4).
- **Classifier on the Box:** found-box mode on the Box target (as for a detector target); no change to scoring. `suggest_goldens.py` exists and may help pick the small set; not looked at in this session.
- **Export numbers:** `versions` export writes originals; a per-picture box list (CSV next to the OK/NG folders) and numbers on the card are new. Downstream's number convention (x, y, w, h or x1, y1, x2, y2) is unknown.
- **UI:** `SECTIONS` in `views.ts` is Overview / Management / Manipulation / Export with the Chain under Overview; the palette is `chain/palette.ts` (`Palette.tsx`). The two step tabs are a new layer; where they sit relative to the four sections is undecided.

## 4. Open decisions (the first one decides the Box math)
1. **Margins measured from the hole centre or from the hole box edge?** (He said "how much to the left from left hole".)
2. Name of the closing module of step 1 and of step 2's Ingest buttons (he said names can change; green OK, red NG).
3. Where the two step tabs sit in the top bar next to Overview / Management / Manipulation / Export.
4. What happens to the step-2 tab when the closing module is removed (he said: a warning, tab stays; removal itself not discussed).
5. Box numbers convention for the exported list (needs his downstream tool).
6. Whether step 1 still needs a Classifier at all: Export takes Evaluation dots directly (pass = OK, fail = NG), so the Classifier is only a label carrier there.

## 5. Not confirmed / to test
- **What NG means physically** (part rotated beyond tolerance, or holes shifted without rotation) was asked twice and **not answered**. The rigid-part box works either way; it matters for how selection should cover NG.
- Test on a small batch downstream: tight upright boxes at large tilt (elongated corners), and whether box-size variation hurts.
- Step 2 chooses from looks only (the measured angle does not cross). A value-spread pick would need the angle; he said labels only.

## 6. In between (not part of the two steps)
- **v1.139.2 to v1.139.5 must be applied in that order** (1.139.2 carries the CLAUDE.md "Stale pictures and screens" section; 1.139.5 needs `frontend-dist-v1.139.5.zip`). His log of 1.139.5 is not seen yet: golden marks should show at once in Classify and `PUT /classify/golden` should be fast.
- **Performance still open:** the first Evaluation after a start or an edit costs 1 to 3.5 s on 2415 pictures (cached afterwards, `flow._remembered_evaluation`); thumbnails of a Dedup view 400 to 600 ms each; Classify refresh job; golden mark is optimistic only in Classify (`PictureGrid` for Dedup/Outliers/Scatter still waits).
- **Flaky test:** `tests/test_clean_schema.py::MigrationV3ToV4Tests::test_parallel_first_connects_on_empty_database` fails about 2 of 60 runs ("database is locked") on the committed v1.139.4 as well; not caused by v1.139.5.
- **Step-1 Dedup view cuts a tilted found box de-rotated** (`dedup_view._upright`), so it hides tilt there. Harmless in step 2 (the Box has angle 0); left as is.
- Ideas parked from earlier sessions: the change indicator for other modules, "list can override the line", multi-element detector targets for Dedup (`plans/dedup-view-and-indicator.md`).

## 7. Working with this user
Short answers, no praise openers; the deciding point or one question first. He discusses step by step and says when code may be changed; do not code before that. He applies and tests patches himself, commits and pushes himself (Claude never pushes; the stop-hook "unpushed commits" message is expected). Docs-only changes ride with the next code patch. The downstream tool cannot import labels, so every extra picture costs him a hand-drawn rectangle: fewer pictures matter.
