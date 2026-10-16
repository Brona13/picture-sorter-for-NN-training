---
name: review-from-dedup-and-insights
description: Dedup scatter selection can batch-label as any class (v1.21.0); Insights confusion-matrix cells open paged Classify cards for FP/FN review (v1.22.0-1.22.2)
session_date: 2026-10-16
last_updated: 2026-10-16
status: current
document_type: session-note
metadata:
  type: project
---

# Review from Dedup and Insights (2026-10-16)

## Built
- **Dedup scatter selection → "Label N as <class>"** (v1.21.0): one button per class of the feature next to Delete. `POST /classify/label-bulk` (`classify_api.py`) wraps `labels.set_labels_bulk`; unknown class or empty list → 422. Overwrites existing labels without confirmation (goldens follow their new label). After labeling, clusters and scatter reload.
- **Insights matrix cells clickable** (v1.22.0-1.22.2): rows = user label, columns = method leaning. `GET /insights/cell` (`insights.cell_frames`, same rule as `build_matrix`, goldens excluded) returns Classify `CardData`. The frontend shows real `Card`s with hover keys plus the Classify `Pager` (client-side paging; per-page/columns shared with Classify via `classifyState().settings` and `setGridSettings`).
- Acting on a card refreshes the matrix counts, but the card stays in the open list until Close (deliberate, so a review pass does not reshuffle).

## Not verified
- Neither feature has been used in a browser on real data by Claude; tests (backend 309, frontend 177, tsc) pass.

## Lessons
- The app serves `app/frontend/dist`: after frontend changes run `./run.sh build`, and restart the backend after adding endpoints (no auto-reload outside `./run.sh dev`), then hard-refresh. The user hit "can't see the buttons" because of this.

## Open / ideas
- Not copied into the Insights list: Classify filters, ranking, Find similar.
- Possible: confirmation/count of overwritten labels on batch label.

## Git
- Commits `f436b57` (1.21.0) and `af7eb60` (1.22.x); pushed to origin/main on 2026-10-16. Docs (`current-project.md`, README) updated.
