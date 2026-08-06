---
name: session-2026-08-06-git-repo-connection
session_date: 2026-08-06
last_updated: 2026-08-06
description: Connected the project folder to its GitHub remote; established what git tracks and what stays out
status: current
document_type: session-handoff
metadata:
  type: project
---

# Session handoff — Git repository connection

## Session objective

Check whether git worked in this project folder, and connect the folder to
the existing GitHub repository.

## Outcome

The folder is now a working git repository, in sync with its remote.

| | |
|---|---|
| Remote | `git@github.com:Brona13/picture-sorter-for-NN-training.git` |
| Branch | `main`, tracking `origin/main` |
| Auth | SSH key, works for fetch and push |
| `gh` CLI | **not installed** — no PR/issue operations available |

Starting point was `9e0e39c "Baseline before refactor: current working state"`,
the only commit on the remote. The session added `87aac59` and pushed it.

## What git tracks, and what it must not

Camera content is deliberately synced **outside git** — GitHub is not suitable
for it, and the frames are large binary data. `.gitignore` enforces this, and it
was verified: out of the whole `cameras/` tree, git sees only the small
`rois.json` files.

Excluded:

- `cameras/*/unsorted/` — source frames (immutable, synced by other means)
- `cameras/*/exports/` — generated exports
- `cameras/*/logs/` — generated diagnostics (added this session)
- `data/*.db` — the SQLite database, ~32 MB
- `.obsidian/workspace.json` — per-machine Obsidian UI state (added this session)

Tracked, and should stay tracked: `cameras/*/rois.json`. These are canonical
ROI coordinates, i.e. domain data, not generated output. They are small.

## Decisions made

- **`cameras/*/logs/` ignored.** The `pekat-cam3/logs/` folder holding a 993 KB
  `method_comparison.png` was deleted locally during the session; the removal is
  recorded in `87aac59`.
- **`.obsidian/workspace.json` untracked** via `git rm --cached` (kept on disk).
  It changes on every Obsidian pane interaction and would dirty status
  constantly. The rest of `.obsidian/` — themes, plugins, appearance — is still
  tracked, including the ~21k-line dataview plugin. Dropping the whole folder
  from the repo was raised and left undecided.
- **Committed directly to `main`.** Single-branch personal repo, and no `gh`
  available to run a PR flow. Feature branches were offered and not taken up.

## Gotchas worth remembering

**`core.fileMode false` is set, and it does not travel.** Every file on disk
carries the executable bit (`-rwxr-xr-x` on `.md` files too), most likely from a
zip or exFAT round-trip. Without this setting, git reports a mode change on all
135 tracked files and any commit becomes a wall of permission noise. The setting
lives in `.git/config`, so **a fresh clone on another machine will show the noise
again** and will need `git config core.fileMode false` set locally there.

**Disk content equals the pre-refactor baseline.** Every tracked file was
byte-identical to `9e0e39c`, whose message says *"before refactor"*. So either
the refactor was never applied in this folder, or it lives somewhere else. Worth
resolving before assuming this folder holds current code.

**Comparing a remote against an uninitialised folder — safe procedure.** Used
`git init` → `git remote add` → `git fetch` → `git read-tree origin/main`, then
`git status`/`git diff` to compare. `fetch` writes only inside `.git/`, and
`read-tree` without `-u` never touches the working tree, so the real files were
never at risk before the differences had been reviewed. Avoid `pull`, `reset
--hard`, or `checkout` in this situation.

**An empty index makes `git diff <commit>` lie.** After `git read-tree --empty`,
every file on disk is untracked and the diff reports the entire repository as
deleted. That output is an artefact, not data loss — repopulate the index before
reading any comparison.

## Open items

- Whether to drop all of `.obsidian/` from the repo.
- `cameras/pekat-cam1` exists on disk but has no `rois.json`, so git tracks
  nothing for it. Expected if its ROIs are not yet defined.
- Locating the post-refactor code, if it exists.

## Related

- [[flow-v3-classify-and-versioning]] — the current core flow
- [[data-model-camera-roi-cutout]] — why `rois.json` is domain data
- [[memory-location-preference]] — why memory lives in the project folder
