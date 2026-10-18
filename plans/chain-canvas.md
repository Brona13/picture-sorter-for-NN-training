---
name: chain-canvas
description: Per-camera visual chain canvas where tool boxes are specific instances; v1 chains ROIs
status: in-progress
document_type: plan
last_updated: 2026-10-18
---

# Chain canvas, v1 (ROI chain)

## Context
`discussions/chain-canvas-handover.md` describes a per-camera visual canvas where the user builds the processing chain from tool boxes. Decisions from the discussion:

- The canvas is **functional**, not only a picture. Start small: chain ROIs.
- A box is a **specific instance** (e.g. "ROI Product", "ROI Feature 2"). It owns that step's parameters and work for the camera. Renaming is cosmetic. Deleting a box deletes the instance and its data, after a warning.
- Ingest is the root, one per camera, not deletable.
- **Merge boxes (A/B)**: later stage, parked. "Run whole chain" button: parked.
- The Overview page is untouched. The canvas is a new view beside it.

Today ROI chaining is implicit: the `role="classify"` ROI assigns frames to products, and a feature ROI is scoped to products through `rois.products_json` (`datamodel.frames_for_feature`). The canvas makes that visible and editable.

## Design
**Source of truth stays in the existing tables.** An ROI box is a view of a row in `rois`. The canvas stores only layout.

- A product is a *class* of the classify ROI, not an ROI. The classify ROI box therefore shows **one output handle per product**. An edge from a product handle to a feature ROI scopes the feature to that product: the product is in the feature's `products` list (shared ROI). Drawing the arrow adds it, deleting the arrow removes it. Several arrows from several handles = several products. A feature with no arrow from the classify ROI applies to the whole camera (today's default). A feature named `<product>::<roi>` is drawn with an arrow from that product's handle, and its scope is fixed by its name (the arrow cannot be removed; renaming is out of scope). These edges are derived from `rois`, never stored twice. (Decided with the user 2026-10-18.)
- Edge Ingest -> first ROI is structural and stored with the layout.
- Layout JSON in the `settings` table, key `chain.canvas`, per camera (no schema bump):
  `{nodes: [{id, kind, ref, label, x, y}], edges: [{from, to}], viewport: {x, y, zoom}}`.
  `kind` is `ingest | roi`; `ref` is the ROI name. Later kinds: `filter`, `detector`, `merge`.
- Reconcile on load: ROIs without a node get an auto-placed node, and nodes whose ROI no longer exists are dropped. The canvas therefore cannot drift from the data.

## Steps
0. ~~Write this plan to `plans/chain-canvas.md`~~ (done). Also add a one-line open-work entry to `docs/current-project.md`.
1. **Check before coding** (read `roi.py`, `datamodel.py`): whether more than one `classify` ROI per camera is allowed (assume one; the palette disables "ROI product" once it exists), what an empty `products_json` means for a feature ROI, and how deleting an ROI purges its settings, labels and goldens (reuse that path for box deletion).
2. **Backend** `app/backend/chain.py` (domain, flat imports) following the `edge_angle.py` read / clean / save pattern:
   - `get_canvas(camera)` returns the reconciled layout plus derived ROI edges and per-node status (frame count for Ingest, class count / labeled count for ROIs).
   - `save_layout(camera, ...)` validates and stores positions, labels and viewport.
   - `add_roi_node(camera, kind=product|feature, ...)` creates a real ROI row with a default rectangle (via `datamodel.save_rois`) and a node.
   - `connect(camera, from, to)` and `disconnect(...)` edit `products_json` (rules: only product ROI -> feature ROI; reject cycles and self-links with 422).
   - `delete_preview(camera, node)` returns what would be lost (counts), `delete_node(...)` performs it. Ingest is rejected.
3. **API** `app/backend/api/chain_api.py`, thin router, registered in `api/main.py`: `GET/PUT /cameras/{cam}/chain`, `POST .../chain/nodes`, `POST/DELETE .../chain/edges`, `GET .../chain/nodes/{id}/delete-preview`, `DELETE .../chain/nodes/{id}`.
4. **Frontend** `views/ChainView.tsx` plus `chain/` helpers; typed calls in `api.ts`.
   - New dependency `@xyflow/react` (only runtime deps today are react, react-dom, react-router-dom). It gives pan, zoom, drag-to-connect, attached anchors and fit-to-view. This is the one thing to approve.
   - Two-tone rounded boxes, accent colour per kind (reuse `HUE` in `ToolIcon.tsx`), inline rename, toolbar palette (Ingest is present from the start; "ROI product", "ROI feature"), fit-to-view button, Ingest changes colour once frames exist.
   - A new tool auto-connects from the last box; the user can redraw the arrow.
   - Right panel via `SidePanel.tsx`: rename, properties summary, "Open in ROI editor" link (carries camera / product / feature), delete with confirmation showing the `delete-preview` counts.
   - Register: `views.ts` `SECTIONS`, a `<Route>` in `App.tsx`, `IconId` + `HUE` in `ToolIcon.tsx`, and `"chain"` in `backend/tools_used.py`.
   - Reuse shared components (`InfoTip`, `ProductSelect`, `SidePanel`); no copied behaviour.
5. **Docs and version**: bump `appinfo.py` to `1.51.0` with today's date; update `docs/current-project.md` (capability, limitations, open work) and `docs/data-model.md` (`chain.canvas` settings key, ROI-edge semantics, delete behaviour); one session note in `memory/`.

## Tests
- Backend (`tests/test_chain.py`, `tests/test_api_chain.py`, `ApiTestCase`, temp dirs only): reconcile adds / drops nodes; connect / disconnect change `products_json` and thus `frames_for_feature`; invalid edges rejected; delete preview counts match what is actually removed; Ingest cannot be deleted; layout round-trips.
- Frontend (vitest, mocked `fetch`): layout load, add node, rename, delete confirmation; pure geometry / reconcile helpers as separate `*.test.ts`.
- Run `.venv/bin/python -m pytest` and `cd app/frontend && npm test && npx tsc --noEmit`. Never touch the real `cameras/` or `data/picture_sorter.db`.
- Manual check with the first test case (Ingest -> ROI product -> ROI feature) against a temp camera root using `run.sh` with temp directories.

## Later (parked, not in v1)
- Bundle size warning from `vite build` (680 kB): silence it or lazy-load `ChainView`; to discuss.
- Filter and detector boxes bound to `vision.<feature>`, hanging from a feature ROI.
- Merge box for A/B branches. It joins variants (ROI / detector); it must never blend classical and ResNet scores.
- One-button "run the whole chain".
- Overview page rework.

## Commit
Per your workflow, commit only after tests exit 0, and push only on request.
