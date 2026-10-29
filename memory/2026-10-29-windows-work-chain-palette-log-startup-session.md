---
name: windows-work-chain-palette-log-startup-session
description: Work on the Win machine 2026-10-28/29 (v1.125.0-v1.130.0) - Chain palette strip, class dots on Classifiers, debug Log with timing table and sortable tables, Chain canvas speed-up, start-up PyTorch preload; how it reached git
status: current
document_type: memory
session_date: 2026-10-29
---

# Work on the Win machine, delivered 2026-10-29 on Linux (v1.125.0 - v1.130.0)

Built in cloud sessions for the work Windows laptop and delivered as eight `git format-patch` files; the user forgot to commit/push there. On 2026-10-29 (home Linux) the patches were placed in `patches/`, applied with `git am`, rebased and pushed. This note is reconstructed from the commit messages and diffs, not from the Windows sessions themselves.

## What each version did
- **1.125.0** Chain: module palette is a vertical strip on the canvas's left edge with one fixed tile size; deleting a box uses the shared overlay (Enter deletes, Esc keeps); right pane shows only the selected box's options, compact; help text under the canvas.
- **1.125.1** Palette drag preview was drawn outside the window on Chrome for Windows (top -1000px); now behind the page at top-left, removed after 100 ms. Cause inferred, not reproduced.
- **1.126.0** Class dots on Classifiers: a line into a class dot puts those pictures in with that class (Evaluation pass = OK, fail = NG, or a Dedup box carrying the class). The two right-pane selectors and the Evaluation confirmation were removed. Chain Classifier counts exclude deleted and muted pictures.
- **1.127.0** Log: debug mode with timestamps and timed steps, timing table (`logs_api`, `applog`).
- **1.127.1** Log remembers its filters; "copy timing table for Claude" (`logText.ts`).
- **1.128.0** Chain canvas works out Evaluation, class-line scope and Dedup pictures once per load (perf).
- **1.129.0** Start-up loads PyTorch and the device at launch, prints terminal progress and a ready line; `startup.py`, `StartupBanner.tsx`.
- **1.130.0** Log page as sortable, filterable, paged tables with request nesting; `TimingPanel.tsx`; timing steps in dedup/state.

## Delivery notes
- 1.125.0-1.126.0 had already been pushed from Windows (`d5728ee`, `2c1757a`, `0af1c00`); the patch copies were skipped by the rebase. 1.127.0-1.130.0 were pushed from Linux as `30e454d`..`1e3ea37`.
- After the rebase: backend 837 passed, frontend 793 passed, `tsc` clean. Not checked in a real browser by Claude.
- `patches/` stays untracked; delete it after use.
- Lesson: my chained push gate (`test ${PIPESTATUS[0]}` after a `| tail` pipe, then a subshell) silently skipped the push; run the push as its own step after verifying the exit codes. See also the commit-on-Windows habit: commit and push on the Windows machine before leaving it.

## Open items
- Real-browser check of the palette strip, drag preview on Windows, class dots, and the new Log tables is open.
- The Linux session of 2026-10-28 open items (deleted counters on fed Classifiers, Merge limits, flaky ResizeObserver tests) are unchanged.
