---
name: refactor-plan
description: Incremental cleanup pass — dead code, encoding fix, feature-picker extract, session-state registry, view_dedup split, engine.curation shim
status: shipped
document_type: plan
last_updated: 2026-08-11
---

# Refactor Plan — Picture Sorter for NN Training

> **Status — shipped (2026-08-11).** Steps 0–6 and the postscript doc fix all executed, one commit per step; Step 7 (DB connection reuse) was skipped as the plan itself instructed unless a real slowdown showed up. Test count 41 → 51 (10 new view-level smoke tests along the way). See commits `7aa5dd0` through `2846467`.

Source: `BEHAVIOR_INVENTORY.md` + `STRUCTURAL_AUDIT.md` (read-only audit, prior session). Verdict: **incremental refactor**, not rebuild — the codebase is "messy but modular," not "structurally tangled" (see audit §8).

Git is initialized with a clean baseline commit. Every step below assumes: commit after each verified step, never batch multiple steps into one commit.

---

## How to use this doc

Paste one step at a time into Claude Code, in order. Do not skip the verification before moving to the next step. If a step fails verification, stop and fix it before proceeding — do not let failures accumulate.

---

## Step 0 — Confirm baseline

**Prompt:**
```
Run the existing test suite (pytest) and confirm it passes on the current baseline commit. Report pass/fail count. Do not fix anything yet — just establish the baseline.
```
**Verify:** all tests currently pass (or you have a documented list of pre-existing failures to compare against later).
**Commit:** none (no code change).

---

## Step 1 — Prune dead code

Audit §8 identifies specific dead code: `curation.CutoutFeatures` and related unused APIs, `ui_common.ranked_key` / `clear_ranked`, unused `source` parameters, the single-target `_TARGETS`.

**Prompt:**
```
Remove the following dead code identified in the structural audit, and nothing else in this step:
- curation.CutoutFeatures and related unused APIs
- ui_common.ranked_key / clear_ranked
- unused "source" parameters (locate and confirm unused before removing)
- the single-target _TARGETS

After removal, run the full test suite and confirm it still passes. Do not touch any other code in this step.
```
**Verify:** tests pass; app still starts (`streamlit run scripts/app.py`) and all 7 views load without error.
**Commit:** `Remove dead code identified in structural audit`

---

## Step 2 — Fix the mojibake ellipsis bug

**Prompt:**
```
Fix the encoding bug in scripts/view_classify/_grid.py:106 where the ellipsis in "Preparing {len(shown)} grid cards and thumbnails…" was double-encoded as "â€¦". Replace with a correctly encoded "…" character. Confirm no other files have the same double-encoding artifact.
```
**Verify:** open the Classify view in the browser, trigger the grid-loading state, confirm the caption renders correctly.
**Commit:** `Fix double-encoded ellipsis in Classify grid loading caption`

---

## ⏸ Checkpoint — view-level smoke tests

The audit notes there are no view-level tests, only pipeline tests (§7,§8). Steps 3 onward touch view files directly, so before proceeding, close that gap for the views about to change.

**Prompt:**
```
The current test suite covers the scoring pipeline but has no view-level tests. Before I refactor view_classify, view_dedup, and the shared feature-picker logic, write smoke tests that catch regressions in current UI behavior for these views — using BEHAVIOR_INVENTORY.md as the source of truth for what "correct" looks like. Focus on: view loads without error for each camera/product state, key state transitions (label click, star/golden toggle, dedup apply) update the right session-state keys, and the known edge cases documented in BEHAVIOR_INVENTORY.md section 8 and 9 hold. This is a testing task only — do not modify application code.
```
**Verify:** new tests run and pass against current (pre-refactor) behavior — they should describe what exists today, not what you wish existed.
**Commit:** `Add view-level smoke tests ahead of refactor (view_classify, view_dedup)`

---

## Step 3 — Extract the duplicated feature-picker

Audit §8: the "compose_feature + whole-frame + feature_label" pattern repeats across four view modules (~5 lines × 4 sites).

**Prompt:**
```
Extract the duplicated "compose_feature + whole-frame + feature_label" pattern (present in four view modules — locate all occurrences) into a single shared helper, e.g. ui_common.feature_picker(camera, product, key). Replace all four call sites. Run the full test suite including the new smoke tests.
```
**Verify:** tests pass; manually check the four affected views render identically to before.
**Commit:** `Extract duplicated feature-picker into shared ui_common helper`

---

## Step 4 — Session-state key registry

Audit §8: session-state keys are scattered as inline f-strings across 8+ files with no registry — the highest-risk source of silent breakage (flagged explicitly in behavior inventory §10, re: the Freeze form reading `classify::<camera>::<feature>` from `_helpers.scored_key`).

**Prompt:**
```
Introduce a session-state key registry (new module or extend
view_classify/_helpers.py) that owns every f"classify::…" and
f"insights::…" session-state key convention with typed accessor functions instead of raw f-string construction. Migrate call sites incrementally: start with view_classify and view_versions (the Freeze form dependency noted in BEHAVIOR_INVENTORY.md section 10 is the highest-risk one — verify it explicitly). Run full test suite after each file migrated, not just at the end.
```
**Verify:** tests pass after every file migrated; manually verify the Versions Freeze form still reads stats correctly after a Classify session.
**Commit:** one commit per migrated file/module (multiple commits expected for this step).

---

## Step 5 — Split `view_dedup.py`

Audit §6, §8: same size/shape that motivated the `view_classify/` and `view_roi_editor/` splits. Use those as the template.

**Prompt:**
```
Split scripts/view_dedup.py (557 lines, 10 helpers) into a view_dedup/ package, following the same structure used for view_classify/ and view_roi_editor/ (separate _styles, _helpers, focused logic modules, and a render.py orchestrator). Preserve all current behavior exactly — use BEHAVIOR_INVENTORY.md section [dedup section] as the checklist. Run full test suite after.
```
**Verify:** tests pass; manually walk through the Dedup view end-to-end (cluster, pick representative, apply, clear) and compare against the behavior inventory.
**Commit:** `Split view_dedup.py into submodule package`

---

## Step 6 — Clean up the `engine.curation` shim

Audit §7: `engine.py` re-exports `curation` at module scope for three unrelated callers with no documented reason.

**Prompt:**
```
Replace the engine.curation.load_image indirection in versions.py, ui_common.py, and view_roi_editor/_canvas.py with direct "import curation" in each of those three files. Remove the now-unnecessary curation import from engine.py if nothing else uses it. Run full test suite.
```
**Verify:** tests pass; confirm `engine.py` still only exports
`resolve_roi`.
**Commit:** `Remove engine.curation indirection shim`

---

## Step 7 — DB connection reuse (conditional)

Audit §8: "if profiling shows it matters." **Do not do this step speculatively.**

**Prompt (only if you've measured a real slowdown):**
```
Profile [specific slow interaction] and confirm db.connect()-per-call is the bottleneck before making any change here. If confirmed, propose a scoped db.connection() context manager using contextvars, and estimate blast radius (how many call sites) before implementing.
```
**Verify:** before/after profiling numbers, not just "feels faster."
**Commit:** `Add scoped DB connection reuse` (only if implemented).

---

## Notes carried over from the audit (don't lose these)

- `versions.revert` is not transactional (behavior inventory §7, structural audit §7) — out of scope for this refactor pass, but worth its own ADR/ticket later.
- `docs/current-project.md` and `app.py`'s docstring both say five views; there are seven. Fix as a trivial doc-only commit whenever convenient — not blocking, not part of the numbered sequence above.
- `labels.set_labels_bulk`'s per-row `clear_label` loop is dormant (UI never offers empty-class bulk clear today) — not worth fixing unless the UI changes to expose it.
