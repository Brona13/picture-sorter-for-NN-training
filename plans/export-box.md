---
name: export-box
description: Plan for an Export box at the end of the Chain (OK / NG dots, golden pictures, freeze then export); decisions of 2026-10-27, nothing built yet
status: built in v1.114.0 (Run button and retiring the old Versions export still open)
document_type: plan
last_updated: 2026-10-27
---

# Export box (plan, 2026-10-27)

**Status: built in v1.114.0 (see `docs/current-project.md`). Still open: the Run button, and retiring the old Versions export.** Getting selected pictures out is the main goal of the app. The Chain is becoming a recipe: per camera, the flow says what to do with the pictures. This plan is for the Export box only.

## What exists today

- Export lives on the Versions page (`versions.py`): a **project version** freezes the verdict pictures (by default only goldens with an OK or NG verdict, `Only goldens`, v1.64.0) and exports them unmodified to `cameras/<camera>/exports/project/v<NNN>__<name>/<OK|NG>/<original filename>`, verifying hashes and reporting missing or changed files. No manifest. See `docs/data-model.md`, "Project versions and export".
- Nothing on the Chain connects to it. Since v1.111.0 an Evaluation has Pass / Fail / All dots that feed Dedup, Picture edits and detector boxes.

## Decisions (2026-10-27)

1. **A sink box at the end of the Chain**, no output dot. The pictures it exports are what arrives on its lines. Every box upstream narrows or passes the set (Evaluation Pass / Fail, Classifier class, Dedup mutes); a preparation box (Picture edits, detector) passes the set on. Deleted pictures (camera-wide) never arrive. A side branch can therefore clean the pictures for every branch by deleting; Dedup mutes apply only to boxes that read from that Dedup box.
2. **Two input dots, OK and NG.** Lines into the same dot are combined by **intersection** (a picture must come through every line). A picture that reaches both dots is left out and reported.
3. **Per product:** when the camera has a product Classifier, folders are `<product>/OK` and `<product>/NG`, the product taken from the picture's product label. A picture with no product label is left out and counted in the preview.
4. **Which pictures:** golden pictures, combined with the class from the dot. "Golden" as today: golden in at least one ROI, with the `Only goldens` tick (default on) kept.
5. **Files:** original pictures only, nothing else for now. **No manifest** for now (it could be generated later from the snapshot).
6. **Snapshot:** reuse the versioning freeze (a DB row: Chain settings from `flow.graph` plus the picture list with hashes; light, no files). **Freeze first, export follows**, both on the Export box's own page. If the Chain changed after the freeze, the page says so, so it is frozen again before exporting.
7. **Preview** with counts per folder before anything is written; a new folder per export (`exports/project/v<NNN>__<name>/`), as today, so nothing is overwritten.
8. **The Run button** (process the whole Chain, then export) comes **later, not now**.

## To do not forget

- **Retire the old Versions freeze / export** (project verdict path) once the Export box works. It stays next to the Export box until then, so nothing breaks. Tracked in `docs/current-project.md`, open work.

## Open

- How the Export box maps to the stored versions (a new kind of project version, or the same `@project` rows with a `source` field).
- Whether a Classifier should become a target of an Evaluation dot (separate feature, not needed for Export).
