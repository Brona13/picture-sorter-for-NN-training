---
name: session-2026-10-14-summary
description: Goldens-only export, Dedup before Classify, app version display (1.1.1), soft-deleted versions with schema v4, startup DB-lock fix, work-laptop GPU setup
session_date: 2026-10-14
last_updated: 2026-10-14
status: current
document_type: session-handoff
metadata:
  type: project
---

# Session 2026-10-14

Context: the app is the React + FastAPI generation (see [[2026-10-13-streamlit-to-react-fastapi-migration]]). Work happened on branch `export-full-frames`; the user applies every patch with `git am` and pushes themselves.

## How the user actually uses the tool (clarified this session)
- "Full frame" in this project means **the cutout produced by the user's other app**, not a raw camera frame. Labelling for the full inference network happens in that other app, inside these cutouts.
- Flow: after ingest, pick **1 strong OK and 1 strong NG as goldens**, recalculate, keep adding goldens until OK/NG separation is reliable. Goldens are added in two kinds: images **far from existing goldens** (coverage) and **very similar OK/NG look-alikes** (the hard borderline cases). Labels are used for the **Insights matrices** (goldens excluded in the UI), to judge how good the golden choice was.
- Caveat raised: 100% on labeled frames can be inflated (goldens counted, tuning goldens on the same labels, small sample). A hold-out of labeled frames never used for picking goldens is the honest check. Not yet done.
- Therefore the **golden set is the curated dataset**; non-golden labeled frames exist for scoring only.

## Decisions and changes (all in app, versions 1.0.2 → 1.1.1)
- **Export** copies **golden frames only**, untouched, original filenames, into `exports/<feature>/vNNN__name/<OK|NG>/`. No cutouts, no manifest. (`app/backend/versions.py`.) Docs updated.
- **Dedup moved before Classify** in the sidebar: Status, Ingest, ROI editor, Dedup, Classify, Insights, Versions. It stays after the ROI editor because it clusters ROI-cutout embeddings per feature. Dedup mutes non-representatives, Classify hides muted frames (show-muted toggle), labeled and golden frames are never muted. Preference: **strict (small-radius) clustering**, so OK/NG look-alikes are not hidden before they can become goldens.
- **Version display**: sidebar shows `v<version> · <date>` from `GET /api/version`; single source `app/backend/appinfo.py`. Scheme: **0.x = Streamlit generation, 1.x = FastAPI + React**. **Bump with every code change** (last number small, middle number features); rule written into `appinfo.py`, README and `CLAUDE.md`.
- **Versions page**: delete a non-active version. The row stays **greyed out, marked deleted**, snapshot items are dropped, numbers are never reused. Deleted versions cannot be reverted to or exported and are not counted in status. **Schema v4**: `versions.deleted` column, in-place v3→v4 migration (v2→v3 now stamps its own version). The real `data/picture_sorter.db` was schema v3 before; it upgrades itself on first start (copy it first as a precaution).
- **1.1.1 fix**: parallel first requests after an upgrade failed with "database is locked" (each request tried the migration). Schema creation/upgrade is now serialized with a lock; tests start 12 parallel first connections on an old and an empty DB.

## Work laptop (HP ZBook Fury G8) and GPU
- i7-11850H (8c/16t), 63 GB RAM, **RTX A2000 Laptop, 4 GB VRAM** (about 2.8 GB already used by Windows/apps at idle), driver 573.86 (CUDA 12.8). C: had about 46 GB free.
- venv had CPU-only torch (`2.14.1+cpu`). Torch 2.14 is built for CUDA 13 (`cu130`), which this driver probably cannot run. Installed **`torch==2.11.0` + torchvision from the `cu128` index**; verified `2.11.0+cu128 True`. The app uses CUDA automatically (`embedding.active_device()`), halves the batch on out-of-memory.
- Sizing estimate (not measured): ResNet18/50 embeddings fit; OWL-ViT base should fit (fp16, small batches); OWL-ViT large / OWLv2 are risky in about 1.3 GB free.
- Work-network constraints: pip needs the proxy; `download.pytorch.org` may be blocked (fallback: download the wheel elsewhere, install the `.whl`).

## Working notes
- The work laptop has **no Node.js**: Claude builds the frontend in its sandbox and sends `frontend-dist.zip`; the user replaces `app\frontend\dist`. Backend-only changes need no rebuild.
- Patches are sent one per version, to be applied in order with `git am` (PowerShell: `"$env:USERPROFILE\Downloads\..."`), `core.autocrlf=true`. A patch fails if an earlier one was skipped; check `git log --oneline` first.
- Launch on Windows: `.\run.ps1`, http://127.0.0.1:8999.
- Claude's cloud session has read-only GitHub access; a stop hook keeps asking to push. Pushing is always the user's step.

## Open
- Add the CUDA install note to `requirements-embedding.txt` (currently points only to the CPU index); would be 1.1.2. Waiting for a yes.
- Unanswered: one ROI per cutout, or several? (affects whether OK/NG class folders are exact per image).
- Unchecked: whether the automatic golden suggestions skip muted frames.
- Hold-out check of the 100% Insights result (see above).
- Version 1.1.1 patch (0005) and this note must be applied and pushed by the user; then merge `export-full-frames` into `main` via a pull request.
