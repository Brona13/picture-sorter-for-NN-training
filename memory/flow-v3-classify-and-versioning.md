---
name: flow-v3-classify-and-versioning
session_date: 2026-07-24
last_updated: 2026-07-27
description: Flow v3 — classification as metadata, per-class goldens with leaning badges, SQLite storage, dataset versioning
metadata:
  type: project
---

The core flow redesign the user arrived at (2026-07-16 evaluation → built 2026-07-24). It **supersedes the accept/reject Sort model** in [[sorting-ux-decisions]] and extends [[flow-and-roadmap]]. Plan: `plans/classify-and-versioning.md`.

**The user's model, in their words:** *"Sorting happens only as recording the pictures' filenames and my classification."* Labels are **metadata records — files never move**. The machine's scores are **advisors** so they can decide *"more precisely and faster"* without going through every picture. They keep every OK/NG call.

**The loop:** mark 1–few OK-golden and NG-golden → **Refresh** re-scores every frame against *both* golden sets with *all* methods (cpu, resnet18, resnet50) → each picture shows a **leaning badge** per method + `novelty` (far from all goldens) and `margin` (confidence) → promote more goldens where coverage is missing, or bulk-label the confident mass → repeat → **freeze a version** → export.

**Confirmed decisions:**
- Labels are **per (frame, feature/ROI)** — the rod can be OK while a connector is NG.
- **Golden = per-class metadata marks**, not the `golden/` folder (that folder is now *legacy*, kept only as the ROI-drawing background; no auto-seeding of marks).
- **Refresh computes ALL methods** every time — disagreement between them is signal (there's a "Methods disagree" filter).
- **Version = recipe, no image copies**: labels + goldens + hashes + counts + novelty stats. **Manual freeze button.** One **active** version per (camera, feature). Revert restores the working state (history preserved — restores are appended, never rewritten).
- **OK/NG two-button UI, open string schema** — more classes later need no migration.
- **SQLite** at `data/picture_sorter.db` (stdlib, no server, travels with the project) holds labels, goldens, versions, score cache. `rois.json` / `ingest_index.json` / `manifest.jsonl` stay as files for now. **Images never go in the DB.**
- **Sort view retired** → `scripts/_retired/view_sort.py` (no git here, so moved not deleted).
- **The `golden/` folder is gone entirely (2026-07-24).** The user deleted it; we confirmed it had only one job left — a background picture for the ROI editor — since scoring references became per-class *marks*. Decision: **no reference folder at all**; the ROI editor draws on **any ingested frame** from `unsorted/`, with a **📌 Pin as reference** button storing a per-camera default (`settings` table in the DB). Rationale: zero setup, no duplicate files, works the moment frames are ingested, and it removes the "golden folder vs golden marks" ambiguity that caused the confusion in the first place. Ingest is now a **single drop zone** (one destination). `rank.py` + `undo.py` retired alongside (they depended on the folder); `engine.score_unsorted` and `Candidate` deleted as dead code.

**Two things learned while building (worth keeping):**
1. **Bulk selection must be leaning-aware, not novelty-only.** With two-sided scoring, `novelty = min(d_ok, d_ng)`, so a frame identical to the *NG* golden also has novelty ≈ 0 — a plain novelty threshold would sweep OK and NG frames into one class. The bulk panel therefore selects *frames leaning class X above a confidence (margin) threshold*.
2. **Marking a golden must NOT clear the scored grid** — the user marks several goldens before one Refresh. Grid stays, badges update live, a stale banner prompts the refresh.

**Golden-count guidance given:** OK 5–10 → grow to ~15–20 (rarely >30; cost is linear); NG 1–3+ given rarity, ideally one per distinct defect mode. When a clearly-OK image keeps scoring novel, that's the signal to add it as a golden.

**Context that shaped this:** batches are 100–1000 frames; NG is rare (<50 total); the user labels *after* keeping; the earlier 93 accept/rejects were only tool-testing.

**UX refinements (2026-07-27):**
- **Pagination** in Classify — a *Per page* selector (12/24/48/96) + `← Prev`/`Next →` + a
  "Page x of y · frames a–b of N" line, replacing the fixed 24-frame cap (essential at
  100–1000 frames). Bulk-label still applies to **all matching frames, not just the visible
  page** (the caption now says so).
- **Self-explaining states** — the user hit "*Order by greyed out and no scores under the
  pictures*" and thought it was broken; it was actually the **cold start** (no goldens →
  nothing scored). Added: a hint when nothing is scored (why the controls are disabled + what
  to do), and a one-sided hint when goldens exist for only one class (leaning badges show
  "– – –" because a leaning needs two sides; `nov` still works meanwhile).
- **Principle worth keeping:** *empty / disabled UI states must say **why** and **what to do
  next*** — a technically-correct-but-silent state reads as a bug. Apply this to future views.
