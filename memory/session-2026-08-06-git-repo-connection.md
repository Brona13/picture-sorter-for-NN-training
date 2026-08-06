---
name: session-2026-08-06-git-repo-connection
session_date: 2026-08-06
last_updated: 2026-08-06
description: Connected the project folder to its GitHub remote, and got the app running on the Linux machine
status: current
document_type: session-handoff
metadata:
  type: project
---

# Session handoff — Git repository connection and Linux runtime

## Session objective

Check whether git worked in this project folder and connect it to the existing
GitHub repository; then get the application running on this Linux machine.

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

## Running the app on this Linux machine

The project was built on Windows and the README documented PowerShell only. It
now carries both platforms; see [Setup](../README.md#setup).

**Environment as found:** system Python 3.12.3, no `python` on PATH (only
`python3`), and a user-level Streamlit in `~/.local/bin` with `opencv-python`,
`scikit-image`, `streamlit-drawable-canvas`, and `streamlit-js-eval` all absent.
No `.venv/` — it is git-ignored and never arrives with a clone.

**Set up:** `.venv/` created with Python 3.12.3 and all of `requirements.txt`
(opencv-python 5.0.0, scikit-image 0.26.0, streamlit 1.61.1,
drawable-canvas 0.9.3, js-eval 1.0.0).

**Run with:**

```bash
.venv/bin/streamlit run scripts/app.py
```

**Failure modes seen, worth recognising again:**

- Entry point is `scripts/app.py`. There is no `./app.py`.
- Running with the system Python looks *partly* successful: Streamlit serves a
  page, then fails inside it on the first missing import. Easy to misread as an
  application bug rather than a missing environment.
- Running from inside `scripts/` instead of the project root.
- `streamlit-drawable-canvas` is pinned to 0.9.3 and depends on Streamlit
  internals. Verified working against Streamlit 1.61.1 via the ROI editor's
  compatibility shim — recheck `view_roi_editor` imports after any Streamlit
  upgrade.

**Optional dependencies are installed — the app is fully functional.** torch
2.13.0+cpu, torchvision 0.28.0+cpu, scikit-learn 1.9.0, plotly 6.9.0, and
umap-learn 0.5.12. The Dedup view, embedding scatter, and ResNet opinions are
all enabled; `embedding.available()` returns True on device `cpu`.

**The CPU-only PyTorch build is the correct one for this machine.** The GPU is
an AMD Radeon RX 7700/7800 XT, so there is no CUDA. Default PyPI wheels would
have pulled roughly 2 GB of unusable CUDA libraries. ROCm builds exist but need
a system-wide ROCm runtime and have uneven support for this chip; not attempted.

Measured on this host (Ryzen 9 5950X, torch using 16 threads), with weights
cached: **resnet18 ≈ 157 frames/s, resnet50 ≈ 66 frames/s**. CPU inference is
not the bottleneck for this tool.

Installing `umap-learn` downgraded numpy 2.5.1 → 2.4.6, because `numba` pins a
supported range. Verified harmless: `pip check` reports no broken requirements
and cv2, skimage, torch, and streamlit all still import.

First neural run downloads pretrained weights to `~/.cache/torch`
(resnet18 45 MB, resnet50 98 MB). Already done on this machine.

**`run.sh` at the project root is the reliable way to launch.** It resolves its
own directory so it works from anywhere, verifies the environment and names any
missing package, then execs the venv's Streamlit with pass-through arguments.
It exists because a system-wide `streamlit` earlier on `PATH` silently runs the
app against the wrong interpreter — the packages are in `.venv/` but the app
reports them missing. Symptom to recognise: `which streamlit` pointing outside
`.venv/bin`.

Note for committing `run.sh`: with `core.fileMode false`, git records new files
as `100644`, so the executable bit must be forced with
`git update-index --chmod=+x run.sh` or a clone gets "Permission denied".

**This machine already runs other Streamlit apps** — `mail_app.py` on 8501 and a
containerised jobscraper on 8505, both long-lived. Port 8501 is therefore taken;
Streamlit auto-selects a free port when none is given, but an explicit
`--server.port` fails outright if busy. Check for a stale instance of this app
before starting a new one.

**Security note:** Streamlit binds all interfaces by default and printed a
public external URL on this host. The apps on 8501 and 8502 bind `0.0.0.0`;
only the containerised one is restricted to `127.0.0.1`. Consider
`--server.address 127.0.0.1`. Not investigated further — firewall state unknown.

## Open items

- Whether to drop all of `.obsidian/` from the repo.
- Whether this host's Streamlit ports are exposed beyond the local network.
- `cameras/pekat-cam1` exists on disk but has no `rois.json`, so git tracks
  nothing for it. Expected if its ROIs are not yet defined.
- Locating the post-refactor code, if it exists.

## Related

- [[flow-v3-classify-and-versioning]] — the current core flow
- [[data-model-camera-roi-cutout]] — why `rois.json` is domain data
- [[memory-location-preference]] — why memory lives in the project folder
