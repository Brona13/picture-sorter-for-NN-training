# Dedup through Calculate, a Muted dot, and Verdict inside Freeze

Status: agreed in discussion on 2026-11-16, not built. Nothing here is code yet.
Version numbers are suggestions; check `app/backend/appinfo.py` when starting.

## Why

Chain seen on the user's camera: Ingest (2906) -> Detector 1 -> Dedup 1 (1440 muted) -> Detector 2 (1466 pictures,
targets `reference-point` and `suspension-cup`) -> Dedup 2 (60 muted) and Dedup 3 (22 muted), one per target ->
Calculate 1 -> Evaluation 1 (1411 pass, 55 fail = all 1466).

Dedup 2 and Dedup 3 are dead ends: a Dedup box may not feed Calculate (`flow.edge_allowed`), and Calculate reads the stored
boxes of its two detector targets, so it counts every picture the detector worked on. The 82 pictures a foreign object
covers still count as pass or fail. The user wants them out of the calculation, and wants to be able to use them later
(label them NG) without Dedup becoming a labeling tool.

## Decisions (all confirmed by the user)

1. **Calculate through Dedup.** A line target -> Dedup -> Calculate carries the point of the target the Dedup box reads
   (same idea as `follow_of` for Picture edits, v1.157.7, and the cascade through Dedup for detectors, v1.157.9).
   A picture counts only if no Dedup box on its path muted it (union of the mutes). Muted pictures drop out of Calculate
   and Evaluation entirely: they are neither Pass nor Fail. A Dedup box may filter one point only; the other point can
   still come straight from the detector. The old direct line and a Dedup line for the same point are not both kept.
2. **Muted dot on every Dedup box.** Like Evaluation's Pass / Fail / All dots. It carries the pictures that box
   muted and only that box's own decision: not what earlier boxes dropped (Dedup 1's 1440 belong to Dedup 1's dot), and
   never deleted pictures. A picture muted by two boxes feeding the same Classifier counts once.
3. **A mute is "not passed on through the normal output", not a global hide.** Behind the Muted dot the picture is a normal,
   visible picture. Labeling it does not un-mute anything: Calculate and Evaluation on the main branch keep skipping it.
4. **The Muted dot feeds a Classifier.** The user labels there (for example all as NG). Dedup never labels (v1.115.0);
   Freeze never labels either. The line into Freeze comes from the Classifier's NG dot, optionally through a Merge
   together with other NG streams (for example an Evaluation's Fail dot).
5. **Verdict lives inside the Freeze box (no new box).** Freeze reads only the lines drawn into it.
   - Clear pictures (one answer, OK or NG) are frozen.
   - Pictures that arrive on both the OK and the NG input are listed on the Freeze page. The user can decide each one
     (OK or NG), change its label in the Classifier (a link opens it there), or leave it.
   - A decision applies **only to the freeze**. It does not change any Classifier label. It is remembered and goes stale
     when the labels behind it change (as `verdict_decisions` did, with its `inputs_sig`).
   - An undecided picture stays out and is reported, as today (`export_box.plan`, the `both` count).
   - NG does not win automatically: a human label is not overridden by a machine opinion, and a contradiction is decided
     by the user (docs/data-model.md, Verdicts).

## Build order (three separate versions, each with tests and a changelog entry)

### Part 1 (v1.161.0): Calculate through Dedup
- `flow.edge_allowed`, `flow.connect`: allow ("dedup", "calc"); carry `point` (the target the Dedup box reads). Check the
  "Calculate takes two points" limit still counts points, not lines.
- The values of Calculate and Evaluation skip pictures muted by a Dedup box on the path; the stale flag follows the Dedup
  mute set (see `dedup_basis.py`, v1.139.0 *Set changed*).
- Chain canvas: line drawing and the Calculate page show the Dedup box in between. Search `chainModel.ts`, `ChainView.tsx`.
- Pictures shown on the Calculate / Evaluation pages must follow the filter (see "Stale pictures and screens" in CLAUDE.md:
  list every place that shows the affected pictures or numbers).
- Tests in `test_flow.py` (allowed line, the point carried, muted pictures excluded, one-point filtering, stale when a mute
  changes) and frontend tests for the line.

### Part 2 (v1.162.0): the Muted dot
- Check first: a Classifier hides pictures muted for its own feature (`classify_api.py`, `db.muted_frames`). A picture arriving
  through a Dedup box's Muted dot must not be hidden by that box's mute. Also check that a Classifier can take a line without
  a class (class dots, `class_lines.py`) and that bulk labeling works on pictures that arrive this way. If not, report what
  has to change before building.
- Add the output dot, the line rules, and the union with duplicates counted once.
- The Merge must accept the Classifier's NG dot, and Freeze the Merge (`flow.py`, `export_box.py`); verify, do not assume.

### Part 3 (v1.163.0): Verdict inside Freeze
- Replace the "reads all quality labels of the camera" logic of `verdicts.py` for the Freeze path with "reads the lines drawn
  into Freeze". Decide what happens to the old Verdict page and the old project freeze (open item 0000 in
  `docs/current-project.md`: retire the old Versions freeze / export).
- Freeze page: counts (clear, contradicting, decided, undecided), the contradicting pictures as cards, decide OK / NG,
  link to the Classifier, decisions stored and flagged stale. Decisions are metadata, not labels: no change to
  `labels.py` state.
- Docs: `docs/data-model.md` (verdicts and the Freeze path), `docs/current-project.md` if the workflow changes.

## Open points (none block Part 1)
- Whether Part 3 reuses the `verdict_decisions` table or needs a Freeze-specific one (schema change if so).
- What the old Verdict page becomes once Freeze decides.
- A "no anchor" style badge for pictures excluded by a Dedup filter on the Calculate page: not discussed.

## Not clicked through
None of this has been seen in a real browser. Each delivery message must say so and give the user a two-line check.
