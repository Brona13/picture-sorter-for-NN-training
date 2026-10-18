---
name: chain-canvas-v1
description: Chain canvas v1.51.0 - what was built, the edge semantics decision, and what is parked
status: current
document_type: memory
session_date: 2026-10-18
---

# Chain canvas v1 (v1.51.0)

Built from `discussions/chain-canvas-handover.md`; plan in `plans/chain-canvas.md`.

- **Decision:** the canvas is functional, but the ROI rows stay the source of truth. Arrows are derived; only the layout is stored (`settings` key `chain.canvas`).
- **Edge semantics (decided with the user):** a product is a *class* of the product-sorting ROI, so that box has one output handle per product. A product arrow scopes a feature ROI to that product through its shared `products` list; no arrow from the product ROI = whole camera. `<product>::<roi>` ROIs get a locked arrow.
- Boxes are specific ROI instances; renaming is cosmetic (layout label). Delete shows a preview and uses the normal ROI delete (labels, goldens, versions are lost); Ingest is one per camera and cannot be deleted.
- New dependency: `@xyflow/react`.
- **Not verified in a browser** (the Chrome extension was not connected): tests use a mocked API; React Flow drag and connect gestures have not been clicked through.
- **Parked:** filter / detector boxes, Merge box (A/B; late stage; never blend classical and ResNet), run-the-whole-chain button, Overview rework.
