---
name: laptop-patches-and-ux-round
description: Applying the laptop's patches v1.23-v1.27, then Dedup reorder, tag filter, ROI zoom, paint labels, Deleted/Verdict pagers and remembered session (v1.28.0-v1.30.0)
session_date: 2026-10-16
last_updated: 2026-10-17
status: current
document_type: session-note
metadata:
  type: project
---

# Laptop patches and a UX round, v1.23.0-v1.30.0 (2026-10-16)

Continues [[review-from-dedup-and-insights]] (v1.21-v1.22). The redesign that followed is in [[dedup-redesign-panel]].

## Laptop patches applied (v1.23.0-v1.27.0)
Five `git am` patches from the Windows laptop session (untracked `patches/`, never commit that folder): Edge angle zoom/pan ([[zoom-pane]]), Configuration page ([[methods-config]]), New camera wizard + tags, Verdicts + Verdict page (schema v7 -> **v8**), project versions/export from verdicts ([[camera-tags-and-verdict-plan]]). They were first dry-run in a scratch clone (applied cleanly; 343 backend and 220 frontend tests passed), then applied here. Their authors show as "Claude".

## What I built on top
| Version | What |
|---|---|
| 1.28.0 | **Dedup moved right after Ingest** in the sidebar (`views.ts`) and the pipeline `STAGES` (`pipeline.py`); it still needs an ROI (user chose "reorder only"). ROI editor frame list excludes soft-deleted frames. Overview tag filter cycles off -> required (check) -> excluded (cross) -> off. `RoiCanvas` uses `ZoomPane` (ROI editor and Detector get zoom/pan). |
| 1.29.0 | **Paint labels** (`classify/paint.ts`, `Card.tsx`): hold 1-9 and move the mouse to label only *unlabeled* cards; hold 0 to clear labeled non-golden cards; goldens never change; cursor becomes a class-coloured dot; each card touched once per stroke. No golden paint mode, no stroke undo. |
| 1.29.1 | Classify "Deleted" view follows the per-page/column settings with the shared `Pager`, pages through days newest first. |
| 1.29.2 | Verdict page: shared `Pager`, column grid, hover keys 1 = OK, 2 = NG, 0 = clear. Grid settings are camera-wide (`verdict.grid.*`, `PUT /verdicts/grid-settings`) because Verdict has no ROI. |
| 1.30.0 | **Remembered session** (`lastSession.ts`, `picturesorter.*` localStorage keys): last camera, product and ROI per camera, last page; root `/` redirects to the last page; a vanished camera/product/ROI falls back to the first. One-line "New camera" form. |

## Lessons
- The app serves the built `app/frontend/dist`: after frontend changes run `./run.sh build`; after backend changes restart `./run.sh`; then hard-refresh. The user once reported "I cannot see the buttons" for exactly this reason.
- `src/test-setup.ts` clears `localStorage` before each test (remembered state leaked between tests). One `DeletedByDay` note test failed once in a full run and passed in 6+ later runs: a rare timing flake.
- Commit hygiene: chain test and commit with `&&` on the *test result*, not on a pipe through `grep`; once a commit went in with one failing test (fixed in the next commit).

## Not verified
Nothing here was seen in a real browser by Claude; all checks were tests. Back up `data/` before the first launch on real data (schema v8); never copy a v8 database to older code.

## Git
`origin/main` is `386ffac` (v1.41.0) at the end of the day; the laptop runs `git pull --rebase` (and restarts the backend, see [[dedup-redesign-panel]]). The user pushes on the words "push it"; do not push otherwise ([[migration-push-state]]).
