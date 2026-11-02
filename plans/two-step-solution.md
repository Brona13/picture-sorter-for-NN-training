# Two-step solution: plan (status: approved 2026-11-02; stage 1 built in v1.140.0, stage 2 in v1.141.0, stage 3a in v1.142.0, stage 3b in v1.143.0, stage 4 in v1.144.0, stage 5 in v1.145.0)

## Context
The user's downstream system is a ResNet detector on whole pictures. He draws one upright rectangle per picture by hand and cannot import labels or boxes. He wants the fewest pictures per round. Today's Chain mixes "decide OK/NG" with "choose goldens". The handover (`discussions/2026-11-02-two-step-solution-handover.md`, base v1.139.5) splits the work into two steps. Nothing is built yet. After approval this file is copied to `plans/two-step-solution.md` (together with the handover commit) and executed stage by stage.

## Decisions (agreed with the user)
- **Two tabs, one canvas each**, inside the Chain page above the canvas; the top bar is unchanged (default, not yet confirmed). Underneath there is **one stored graph** with a `step` per box (existing boxes = step 1). The palette shows only the modules of the open step. The step-2 tab appears only when a Freeze module exists. Step 2 starts empty.
- **Step 1** keeps today's modules, with these changes: the Classifier is for labeling only (no golden functions), and there is a new closing module **Freeze**. Freeze is the existing Export box with "Only goldens" off, no product folders and a new name. The step-1 palette offers Freeze instead of Export.
- **Hand-over = labels only** (OK/NG per picture, from the last Freeze). The measured angle does not cross.
- **Step 2 modules:** **Ingest OK** (green), **Ingest NG** (red), **Box**, **Classifier**, **Export**.
  - Step-2 Classifier: goldens and **Mute** (per box, undoable), no labeling, no camera-wide delete. Hint on the screen: "Wrong label? Change it in step 1 and Freeze again."
  - Export: goldens, original pictures in OK/NG folders, plus the box numbers per picture (also shown next to each picture).
- **Box module:** one upright rectangle per picture, for all pictures. First version is the two-box case: L/R from the two hole boxes, U/D along the part's own direction (turned with the angle), squared off to the smallest upright rectangle. The setting "measure from: box edge (default) / box centre" belongs to the Box. The one-box option (one detector box plus four margins) is a later stage.
- **Warnings:** if step 1 changed since the last Freeze, the step-2 tab shows a warning (`export_box.state()['changed']`). If the Freeze module is removed, the step-2 boxes stay and Ingest shows 0 pictures plus the warning "Step 1 has no Freeze module".
- **No Dedup box in step 2 at first.** It can be added to the step-2 palette later.
- Existing goldens in the database are kept; step 1 hides them, step 2 shows them.

## Stages (each = one version, one commit; backend + frontend + tests + docs)
1. **Step flag and Freeze.** `flow.py`: `step` per node (default 1), `KINDS`, load/save. `export_box.py` mode for Freeze (goldens off, no product folders). `chain/palette.ts`, `Palette.tsx`, `ChainView.tsx`: Freeze in the step-1 palette, tabs above the canvas, the step-2 tab only with a Freeze, the warning marker. Step-2 tab empty at first.
2. **Ingest OK / Ingest NG.** New root kinds reading the items of the Freeze box's last frozen project version by class (`export_box._versions_of`, `versions`). Everything after them reads the picture list as after Ingest. Warning and 0 pictures without Freeze. Palette of step 2 (Ingest only at this point).
3. **Classifier per step.** Step 1: no golden functions (a `goldens` switch next to the existing `labeling` prop in `ScatterWorkbench`, `ClusterBrowser`, `OutlierPanel`, `PictureGrid`, `Card`). Step 2: no labeling, Mute in the same views (reuse `dedup.mute_frames`/`unmute_frames`, `db.muted_frames`, `GridMute`). **First task of this stage, before coding:** settle which feature carries labels and goldens in step 2 (goldens are scoped by camera, feature, frame, and a golden needs a label), so the step-2 Classifier can mark goldens on the labels made in step 1. Talk this through with the user if the code does not give one obvious answer.
4. **Box module (one or two detector boxes).** New kind `box` (step 2, `box_module.py`). The detector boxes of step 1 are **chosen in the Box's right pane** (a list, no lines: the detectors live in the other step) with a switch **one box / two boxes**. Two boxes: the left hole sets the left edge, the right hole the right edge, up and down from both, in the part's own direction (from the left hole to the right hole); one box: all four edges from that box, in its angle. **Measure from the box edge (default) or its centre**; four margins (left, right, up, down). The turned rectangle is squared off into the smallest upright one. The result is stored in the stored-detector format (one target `box`, angle 0) and read through `flow.load_stored`, which makes it again when the settings or the detector runs change, so anchors, cut-outs and the Classifier read it unchanged; the Box has one output dot (`t:box`) that is drawn onto a step-2 Classifier (anchor). Reuses `flow.whole_picture_boxes` (the moving of stored boxes by the crops above their detector, shared with `calc_boxes`). Page: example picture with the detector boxes, the dashed turned rectangle and the solid upright one; dragging the middle of a dashed edge changes that margin in the part's own direction; the four numbers are typed in the panel.
5. **Classifier on the Box (done in v1.145.0).** End-to-end test of the chain on synthetic pictures; fixed: the Box follows its detectors' stored results, a Box gives the pictures it has a rectangle for, "Suggested goldens" works on labeled pictures in step 2 (promote only marks the golden), and the Classifier's pictures carry a key that changes with the Box's margins (`picture_key.py`). Still to do on real pictures: look at the cut-outs and the scores in the browser.
6. **Step-2 Export.** Goldens, OK/NG folders with originals, per-picture box list (CSV next to the folders), numbers on the cards. Uses the existing `freeze` → `versions.export` path.

## Open (decide when its stage starts)
- Tab placement (default above the canvas) and the colour/wording of the warning.
- Number format of the exported box list (x, y, w, h or x1, y1, x2, y2); needs the downstream tool.
- What NG means physically (affects how NG pictures should be covered when choosing goldens).
- Stage 3 feature scope for labels/goldens in step 2.
- Test downstream on a small batch: tight boxes at steep angles, and whether a varying box size hurts.

## Rules for every stage
- Bump `VERSION` and `RELEASED` in `app/backend/appinfo.py` (minor for features). Update `docs/current-project.md` and `docs/data-model.md` (and README if the workflow text changes) in the same commit; update the domain invariants in `CLAUDE.md` if they change (step flag, Freeze).
- Tests only against temp `CURATION_CAMERAS_ROOT` / `CURATION_DATA_DIR`; never the real `cameras/` or `data/picture_sorter.db`. Backend tests for each rule, frontend tests that assert the changed picture `src`.
- Chain commits on the test exit codes: `.venv/bin/python -m pytest` then `cd app/frontend && npm test && npx tsc --noEmit`.
- Commit locally after tests pass. Push only when the user says "push it".
- After each stage give the user a two-line browser check, and say plainly what was not clicked through.

## Verification (end to end)
1. Backend and frontend suites and `tsc` pass after every stage.
2. Manual, after `./run.sh build` and `./run.sh`: build step 1 and Freeze, open the step-2 tab (empty, Ingest OK/NG only), then add a Box on two detector targets and check that the rectangle follows a tilted part. Mark goldens in the Classifier on the Box and mute one picture. Export and check the OK/NG folders and the box list. Change something in step 1 and see the warning. Remove Freeze and see Ingest show 0 pictures with the warning.
