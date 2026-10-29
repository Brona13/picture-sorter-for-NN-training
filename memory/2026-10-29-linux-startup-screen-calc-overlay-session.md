---
name: linux-startup-screen-calc-overlay-session
description: Session 2026-10-29 on Linux (v1.131.0-v1.131.2) - start-up screen, Calculate overlay for two detectors (same picture, then different crops), Space reference fix, dead tests revived; decisions, lessons, open items
status: current
document_type: memory
session_date: 2026-10-29
---

# Session 2026-10-29 (home Linux): start-up screen, Calculate overlay with two detectors (v1.131.0 - v1.131.2)

Preceded by the Windows patches (v1.125.0-v1.130.0), see [[windows-work-chain-palette-log-startup-session]]. Browser-testing plan: [[browser-testing-plan]].

## Done
- **v1.131.0 start-up screen** (`979babb`): `termui.py` (boxes, spinner, `fancy()` = TTY + UTF-8 + not `NO_COLOR` / `TERM=dumb` / old Windows console), `startup.banner()` and `_run_fancy`; plain lines remain for pipes and tests. `run.sh` passes `--log-level warning` (uvicorn's per-request lines no longer share the terminal; they are on the Log page; `PICTURE_SORTER_VERBOSE=1` restores them) and exports `PICTURE_SORTER_URL` (honours `--port`). `run.ps1` untouched. Seen only in a pty, not in the user's own terminal.
- **v1.131.1** (`c4ef6ca`): Calculate overlay when A and B come from two detectors with the *same input* (`flow.calc_point_sources`, `point_sources` + `same_picture` in the calc detail; `FlowBoxView` merges both detectors' boxes).
- **v1.131.2** (`49ade9c`): overlay when the detectors sit behind *different* Picture edits boxes: `flow.calc_boxes` moves both boxes onto the whole picture with `rect_map` (same mapping as `_calc_pairs`), `GET flow/nodes/<calc>/calc-boxes`, viewer shows the whole picture. Also hold-Space reference picture works again on such a chain.
- **Dead tests revived:** `width_of` / `height_of` sat in the middle of `FlowTests` (tests/test_flow.py), so ~6 tests after them were never collected (the anchored-ROI and calculate-detail ones). Moved above the class; one stale test fixed. File now 58 tests, whole suite 845.

## Lessons
- **"Same picture" was misread (cost one round):** I took it as "same detector input"; the user meant the same original photo while each detector sits behind its own Picture edits. Ask what "same" refers to when a picture / coordinate system is involved.
- **The first fix was never seen in a browser**, and the user's screenshot showed nothing changed. The second fix was checked in headless Chrome on a seeded camera that copies the user's chain (Detector -> two crops -> two detectors -> Calculate angle -> Evaluation) before being called done. For UI changes do that first.
- **Space "alternate view" was not new development:** the reference-picture feature already existed in `ValueGrid` (`extras.reference`, `referencePicture.ts`); it vanished because `FlowBoxView` returned no viewer extras without one detector. When the user says "copy what we already built", find the existing code and fix why it is not reached.
- The chained push gate with `test ${PIPESTATUS[0]}` after `| tail` skipped the push silently; push as its own step after checking exit codes.
- Seeded-camera recipe for a browser check (scratchpad scripts, not committed): `CURATION_CAMERAS_ROOT` / `CURATION_DATA_DIR` in temp dirs, frames from `tests.test_rotsearch.component` / `turned`, graph built through `TestClient(create_app())`, then uvicorn on 8765 and headless Chrome on 9333 over CDP; the UI has no URL routing (state only), so click through Overview -> the Evaluation card.

## Open items
- The user has not yet run `./run.sh build` and looked at v1.131.2 on real data; the start-up screen in a real terminal is also unseen.
- Straightening crops: the turn sign added to a box angle in `calc_boxes` is untested.
- Browser-testing harness (`tools/browser_check/`, Playwright leaning) not built; waiting for the user's go-ahead and four decisions.
- Older open items unchanged (deleted counters on fed Classifiers, Merge limits, flaky `ResizeObserver` tests).
