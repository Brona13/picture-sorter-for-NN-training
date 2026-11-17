---
name: dedup-calculate-muted-freeze-session
description: Session 2026-11-16 (v1.160.1-v1.163.0, Linux) - applied the V01 naming patch, then Dedup feeds Calculate, a Dedup Muted dot, and OK/NG decisions for contradicting pictures inside Freeze; all pushed
status: current
document_type: memory
session_date: 2026-11-16
---

# Session 2026-11-16 (Linux home workstation): Dedup -> Calculate, Muted dot, Freeze decisions, v1.160.1 - v1.163.0

Behaviour now: `docs/current-project.md` (Calculate, Dedup, Freeze lines) and `docs/data-model.md` (*Freeze decisions*). Per-version details and tests: `docs/changelog.md`. The agreed design and build order: `plans/dedup-muted-dot-and-freeze-verdict.md`.

## What happened

1. Checked Git for a newer version (none), then applied `patches/picture-sorter-v1.160.1.patch` (versions written `V01`, `V02`) with `git am` and ran all tests. The user later asked for the processed patch file to be deleted and the `patches/` folder kept (empty).
2. The user described a real chain: Ingest (2906) -> Detector 1 -> Dedup 1 (1440 muted) -> Detector 2 (targets `reference-point`, `suspension-cup`, 1466 pictures) -> Dedup 2 (60 muted) and Dedup 3 (22 muted), one per target -> Calculate 1 -> Evaluation 1 (1411 pass, 55 fail). Dedup 2 and 3 were dead ends: Calculate counted all 1466 pictures, because a Dedup box could not feed Calculate. Covered pictures (a foreign object) should be left out of the calculation but kept to label NG later.
3. Long discussion first, one question at a time in simple terms, then built in three separate versions, each with tests, changelog, local commit:
   - **v1.161.0 Dedup -> Calculate.** Line target -> Dedup -> Calculate carries the point; `flow.calc_filter` drops pictures a Dedup box muted from Calculate, Offset and Evaluation (neither pass nor fail). One Dedup line filters the whole Calculate; a Dedup line replaces a direct line for the same point; a Dedup box reading no target is refused.
   - **v1.162.0 Muted dot.** Second output of a Dedup box (handle `p:muted`) = pictures that box muted, only its own decision. Into a Classifier's plain input (setting `roi.dedup.muted.<feature>`): the Classifier works on exactly those pictures, the box's mute does not hide them there, the user labels them by hand. Counted once when two boxes muted a picture.
   - **v1.163.0 Freeze decisions.** The old Verdict idea, inside the Freeze box (no new box): pictures on both OK and NG inputs are listed on the Freeze page; OK / NG per picture or in bulk; for the freeze only (no label changes); stored as setting `freeze.decisions.<box>` with a signature, stale when the answers behind it change. The old Verdict page and project freeze are untouched (open item 0000 still to retire them).
4. Pushed to `origin/main` (`0de9496..2c49c5e`) on the user's word "push".

## Decisions the user made (do not re-ask)

- Dedup never labels; the Classifier is the one place that sets labels. Freeze takes only lines drawn into it and only labeled pictures.
- "Not good" means the NG label; a bad-quality picture is deleted instead.
- A mute means "not passed through the normal output", not a global hide. A label never un-mutes.
- A contradiction (OK on one line, NG on another) is never resolved automatically: not NG-wins, not a machine opinion over a label. It is left out until the user decides it in Freeze.
- Not built a new Verdict box (too complex for a user); placed in Freeze.

## Not clicked through in a real browser

All three versions were tested with mocked API / unit tests only. Check lines are in each changelog entry. Nothing here was run on the real camera.

## Open

- Retire the old Verdict page and Versions freeze (item 0000, now that Freeze decides contradictions).
- The confirmation text when deleting a Dedup -> Calculate line uses the generic wording.
- The Freeze contradictions list is capped at 500 pictures (the count is the whole number).
