---
name: two-step-solution-session
description: Session 2026-11-02 on Linux (v1.139.1-v1.147.0) - the two-step solution built in stages (step flag and Freeze, Ingest OK/NG, step-2 Classifier, Classify per step, Box, end-to-end check, Export with box numbers, Box input); decisions with the user, faults found by tests, lessons, open items
status: current
document_type: memory
session_date: 2026-11-02
---

# Session 2026-11-02 (home Linux): the two-step solution, v1.139.1 - v1.147.0

Plan: `plans/two-step-solution.md` (all stages done). Idea and mapping onto the code: `discussions/2026-11-02-two-step-solution-handover.md` (written before building). Current behaviour: `docs/current-project.md` (entries v1.140.0 to v1.147.0), `docs/data-model.md`, README section "Two steps". Everything is pushed (`origin/main` = `2cb6e82`).

## Done (one version per commit)
- **Start:** pulled v1.139.0 and applied five Windows patches in order: v1.139.1-5 (`5a5694e`, `a52c530`, `e7ba564`, `b30c3b3`, `84e7d92`). The patch files were then deleted (folder `patches/` stays, untracked).
- **v1.140.0** (`c12acf9`, stage 1): a box carries `step` (default 1). A step-1 Export box is the **Freeze** module (every OK/NG picture, no goldens, no product folders). Chain page: tabs **Step 1 / Step 2**, step 2 appears with a Freeze (or step-2 boxes) and warns when step 1 changed, was never frozen or has no Freeze. One stored graph, a line never joins the steps.
- **v1.141.0** (`5f14ed6`, stage 2): **Ingest OK / Ingest NG** (kinds `ingest_ok`, `ingest_ng`, `piles.py`): the OK/NG pictures of the last freeze, read from the frozen version, not the live Chain.
- **v1.142.0** (`4fd41c1`, stage 3a): a Classifier has a step (`roi.step.<feature>`); Ingest OK feeds its OK dot, Ingest NG its NG dot (class lines), labels follow the freeze and are locked.
- **v1.143.0** (`8c279b4`, stage 3b): Classify screens per step (`classify/stepMode.ts`): step 1 labels/deletes, no golden marking (data stays); step 2 goldens + **Mute** (`POST classify/mute`, own mute), no labeling, no camera-wide delete, hint "Wrong label? Change it in step 1 and Freeze again".
- **v1.144.0** (`2eece3d`, stage 4): **Box** (`box_module.py`): one upright rectangle per picture from **one or two** step-1 detector boxes chosen in its panel (no lines), measured from box edge (default) or centre, four margins, turned with the part and squared off; stored in detector format; anchor target `box`; page with example picture, dashed turned and solid upright rectangle, draggable edge dots.
- **v1.145.0** (`e6acc3f`, stage 5): end-to-end test on synthetic pictures found three faults (below); `picture_key.py` makes thumbnail addresses change with the Box's margins; suggested goldens work on labeled pictures in step 2.
- **v1.146.0** (`9a0d699`, stage 6): step-2 **Export**: rectangles frozen with the version, `boxes.csv` (semicolon; layout `corners` x1,y1,x2,y2 default or `size` x,y,width,height), numbers on the Classify cards; README section.
- **v1.147.0** (`2cb6e82`): the Box takes **Ingest OK / NG as input** (left dot); with lines it works on those pictures, with none on every picture.

## Agreed with the user (his words, short)
- Two tabs, one canvas each; step 2 starts empty; one graph underneath is fine. Remove Freeze -> step-2 boxes stay, warning.
- Closing module of step 1 = **Freeze**; step-2 starts **Ingest OK / Ingest NG**; Classifier exists in both steps: step 1 labeling only, step 2 goldens + Mute only; old goldens stay in the data.
- The Box lists the step-1 detector boxes in its right pane (one or two) - **not lines** (I proposed lines first and was corrected); one-box option belongs in the same stage, not a later one.
- He wanted the Box to have an input dot fed by Ingest OK/NG (I had built it without) - done in v1.147.0.
- Margins from the box edge by default, choice of centre.

## Faults the tests found (fixed)
1. A Box did not follow a detector run again with the **same settings** (it watched the settings signature, not the stored results).
2. A Classifier anchored to a Box saw **no pictures** (a box with no input line has none; `flow._node_frames` now asks `box_module.frames`).
3. "Suggested goldens" **never offered anything in step 2** (only unlabeled candidates; promote relabeled). Now labeled candidates and promote only marks the golden.
Also: the pointer-up handler of the Box drag used a stale drag (found by a jsdom test).

## Lessons
- Read the handover before proposing a UI: I invented "draw lines into the Box"; the document already said "list in the right pane".
- The user's `Ask in plain text, one question at a time, short` style works; he finds long explanations hard - use short lists and one recommendation.
- Headless Chrome check (recipe in memory `feedback-verify-ui-in-headless-chrome`): done for the Box page at the end (overlay exactly on the picture, real drag saved the right margin, tilted part 28.1° turns correctly). My first drag script used the wrong sign for the part's "up"; the app was right. I should have done it at v1.144.0, not three versions later.
- A full-suite flake (random unrelated frontend test) happened four times while a game ran (load ~10); see memory `frontend-tests-flaky-under-load`. I also stashed the working tree while a background pytest ran - do not.
- Stop temporary servers with `fuser -k <port>/tcp`, not `pkill -f`.

## Open items
- **Downstream number convention** for `boxes.csv` unconfirmed (both layouts offered, `corners` default).
- **What NG means physically** (rotated beyond tolerance or holes shifted) was never answered; matters for covering NG when choosing goldens.
- The drag semantics of the Box page (drag the dashed turned rectangle's edges; the solid upright one is not draggable) were built as proposed; the user never said yes or no.
- Not seen on real pictures: cut-outs, scores and the Export on his real camera; the Windows laptop needs `git pull --ff-only`, a restart and a **frontend-dist zip** (not built).
- Still shown in step 1 on purpose: scoring bars/ranking against goldens, golden counts in the KPI boxes, golden controls of the Evaluation labeling page (`FlowBoxView` / `ValueGrid`).
- Parked: a Dedup box in step 2; "multi-element detector targets for Dedup" (`plans/dedup-view-and-indicator.md`); the ~15 `kind == "detector"` places were not generalised (the Box works through load_stored / anchor only).
- Performance items from the handover (first Evaluation 1-3.5 s, thumbnails of a Dedup view 400-600 ms, PictureGrid golden mark not optimistic) untouched.
