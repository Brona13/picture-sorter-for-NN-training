---
name: detector-count-and-box-samples-session
description: Session 2026-10-26/27 (v1.107.0-v1.108.3) - detector with several same elements (count 1-4), Classifier on found boxes, one Classifier picture per box (sample ids file#n); decisions, open items
status: current
document_type: memory
session_date: 2026-10-27
---

# Session 2026-10-26/27: several elements per target, boxes as Classifier pictures (v1.107.0 - v1.108.3)

- **v1.107.0** A box takes the pictures from the line into it (Dedup -> Picture edits works); node-scoped frame lists (`GET flow/nodes/{id}/frames`).
- **v1.107.1-6** Log filter "since app restart"; version printed at backend start; Esc cancels a rectangle being drawn on the Detector page; creating a camera refuses an existing name and clears orphan rows; Ingest progress bar shows the overall progress; page reloads after camera create/delete and API GET is no-store (the "orphans after recreate" problem was browser state).
- **v1.108.0** A detector target can look for `count` 1-4 similar elements, boxes numbered left to right: `name 1..N`. A count change is refused while lines, cascade or ROI anchors use the target.
- **v1.108.1** (superseded) Classifier on all boxes as one side-by-side strip. **v1.108.2** Chain dot `name (all)`.
- **v1.108.3** He changed his mind after seeing the strip: **every found box is its own Classifier picture.** Sample id `<file>#<n>` (`samples.py`, `samples.ts` label "file · box n"). `datamodel.frames_for_feature` expands files into found-box samples (a missing box is a missing sample); `anchor.entry_for` / `Source.entry` resolve the number to the slot; `frame_path`, `classify.prepare`, `roi_rect`, versions and detector helpers map a sample to its file; `db.frame_hash_map` is a `samples.HashMap` so labels, goldens, bin and mutes key on `<hash>#n`. Anchoring on one numbered box stays a normal per-file anchor.

His scenario: a detector expects N same elements; the Classifier sees N times more pictures, one box each; he labels each box OK/NG; the picture-level "all boxes OK" verdict is a later separate step (like Roboflow's per-crop verdicts).

Mistake worth remembering: test pictures built from two identical patches give identical vectors and thumbnails; do not assert they differ.

Open: picture-level verdict from the boxes; a Dedup box downstream of a group-anchored Classifier uses a fallback anchor (untested); ROI editor overlay for such anchors; old labels on a group-anchored Classifier (keyed by file) do not map to samples; Ingest grid "fit" thumbnail (whole picture, no centre crop) waits for his yes; request-tracking system (discussed / in plan / not tested / finished) deferred; real-browser check is his.
