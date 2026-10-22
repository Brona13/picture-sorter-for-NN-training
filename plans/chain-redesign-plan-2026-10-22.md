---
name: chain-redesign-plan-2026-10-22
description: Plan for the Chain redesign - decisions from the 2026-10-22 discussion, version order v1.88.0 to v1.93.0, per version changes, wipes and checks
status: draft-plan
document_type: plan
created: 2026-10-22
related: session-handover-2026-10-22.md, current-project.md, north-star-handover.md
---

# Chain redesign: plan

Nothing is built. Code state is v1.87.0. Version numbers below are proposals.
This plan follows `session-handover-2026-10-22.md` and records the decisions made in the discussion that followed.

## 1. Ground rules

- Test data is disposable. No migration code. Each version says what it wipes.
- Every box is defined by what goes in and what comes out. The Chain checks only that types match.
- Any box can be placed anywhere, several times, also behind a box of the same kind.
- The Chain becomes the main way to work. Menu functions move into boxes step by step.
- Short steps, one problem at a time.

## 2. Decisions

### What a line carries
A line carries two things: a **set of frames** and a **picture** (whole frame, crop or filtered).
Today the frame set comes from product lists on the ROI and the picture from `roi.input` and Picture edits. Both must travel along lines. Version 4 defines this.

### Lines
- No automatic lines at all. This includes the existing exception in `flow.create_node` (first Crop/Detector joined to Ingest).
- An **output feeds any number of boxes**. A second line from the same output removes nothing.
- An **input accepts one source** (Calculate: one source per input slot, not per box). Drawing a second line onto a taken input replaces the old one, only after confirmation.
- Delete: select the line (turns blue), press Delete. An overlay says what changes (source, target, effect). Enter confirms, Esc cancels.
- Reconnect onto a taken input: same overlay. The new line is made only on confirm. Cancel keeps the old line.
- **Deliberate exception:** the Evaluation of a Classifier is chosen in its panel, not drawn (see Classifier).

### Classifier box (merges ROI, product, feature and Classify)
- One box type, **Classifier**, with **Mode**: Product or Feature.
- The separate Classify box goes away. The ROI editor and the Classify page become the page of this box. The right panel holds product scope, detector anchor and Picture edits input.
- Product names are whatever the user creates. No automatic A, B, C.
- Outputs: **one dot per class** and **one all dot** (top right). Product mode: one dot per product. Feature mode: OK and NG.
- **The all dot passes only classified frames.** It equals drawing a line from every class dot. Unlabeled frames never leave a Classifier. They show only on its own page (Show: Unlabeled).
- A Feature Classifier behind the all dot of a Product Classifier sees only frames with a known product.
- Bin (deleted) and unlabeled are counters on the box, not outputs.
- Evaluation: picked in the right panel, no dot, no line. One at most. Deleting that Evaluation box clears the choice and the panel says so. Value, verdict and the Show → Measurement filters stay as today.

### Box size and look
- One colour per box type.
- Fixed width per box type.
- Height fixed per type, **except the Classifier**: one row per class (name, picture count, output dot), plus one bottom row for the bin and unlabeled counters. Feature mode has two classes, so its height is fixed in practice.
- Long product names are shortened in the box. Full name on hover and in the panel.
- Many products (for example 20) make a tall box. Not decided, left for later.
- Picture edits box: no step list. A crop icon and a filter icon, each with a number badge when used more than once. An icon shows only if that step type is in the list.

### Dedup box
- New box, picture in, picture out. Placeable anywhere.
- Scatter, Clusters and Outliers become views inside its page. Embedding choice in its panel.
- **Mutes belong to the box.** Two Dedup boxes can hold different mutes. Muted pictures are hidden by default, with a Show muted toggle.
- Muted frames are not passed on.
- To dedup the whole dataset, place it right after Ingest. Behind a Classifier it sees only classified frames.
- Rejected alternatives: Dedup inside Ingest (loses the ROI crop, per-box mutes and per-class dedup), Dedup as a Classifier view.

### Picture edits panel
- A collapsed step is one line: grip, name, expand arrow, on/off toggle. The operation dropdown moves into the expanded part.
- **Only one step is open at a time.** Selecting a step opens it and collapses the previous one. The open step is the one the big picture shows (Before / After).
- Off toggle = bypass. The step keeps its place, is skipped when processing, and is dimmed. An off step can still be selected and opened.
- The toggle counts in the box signature. A detector behind it goes stale, as with any step edit.

### Module palette
- Replaces the "+" buttons. Square tiles in the Chain's right panel, 2-3 per row, drawn two-tone icon (`ToolIcon.tsx`) and a short label, grouped by input / output type.
- Drag and drop from the start: a ghost of the final box follows the pointer, the box is created where it is dropped. Click to add also works.
- A new box is always unconnected.

### Menu
- Redundant after the Classifier: ROI editor, Classify page.
- Redundant later, as they become boxes: Detector, Edge angle, Dedup pages.
- Stay: Overview, Ingest, Verdict, Versions.

## 3. Version order

### v1.88.0 Lines
**Changes**
- Remove every automatic line, including the `flow.create_node` exception.
- Line delete overlay (Enter / Esc).
- Reconnect overlay when an input is taken. Output fan-out stays free.
- Per-input-slot rule for Calculate.

**Wipes:** nothing. Existing lines stay.
**Check:** new Crop / Detector in an empty graph has no line. Delete shows the overlay, Esc keeps the line, Enter removes it. Drawing A to C where C is taken shows the overlay. A second line from one output shows none. Component tests plus one real browser pass.

### v1.89.0 Picture edits
**Changes**
- One-line collapsed steps with on/off toggle. Only one open step.
- Bypass in `signature()`.
- Fixed box size with crop and filter icons and badges.

**Wipes:** nothing. Steps keep their stored shape. Add an `enabled` flag, default on.
**Check:** switching a step off changes the output and makes a detector behind it stale. Off step is dimmed and still openable. Badge counts match the list.

### v1.90.0 Module palette
**Changes**
- Tile grid in the right panel. Drag and drop with ghost. Click to add.
- One colour and one fixed size per box type (Classifier excepted, see above).

**Wipes:** Chain layout positions may change (`chain.canvas`). Disposable.
**Check:** drop lands at the pointer. Click adds at a free spot. No line is created.

### v1.91.0 Line semantics
**Changes**
- Define in / out types: frame set and picture.
- The frame-set rule: class dots, all dot (classified only), muted frames not passed.
- Type check when drawing a line. A mismatch refuses the line with a reason.

**Wipes:** nothing yet. Design and checks only, little visible change.
**Check:** unit tests for the frame-set rule on a temporary camera (`CURATION_CAMERAS_ROOT`, `CURATION_DATA_DIR`).

### v1.92.0 Classifier box
**Changes**
- Merge ROI box, product ROI and Classify box into the Classifier with Mode.
- Dots per class plus the all dot. Counters row. Name shortening.
- ROI editor and Classify page become its page. Panel: scope, anchor, picture input, Evaluation choice.
- Product-scoped features follow a product dot line. The `<product>::<roi>` naming scheme and `db.rename_products` are reworked.
- Remove the dead output dot (the one added in v1.63.3) with the old feature box.

**Wipes:** the old ROI and Classify box storage, product scope lists, `roi.input.<feature>` shape, Chain layout. Labels and goldens should be kept where the new shape allows. Say what is lost before starting.
**Check:** a Product Classifier with three products feeds a Feature Classifier from the all dot and from one class dot. Unlabeled frames do not pass. Rename a product. Evaluation pick shows value and verdict on cards. Deleting the Evaluation clears the choice.

### v1.93.0 Dedup box
**Changes**
- Dedup box with Scatter, Clusters and Outliers views.
- Mutes stored per box. Show muted toggle.
- A cluster Apply reconciles mutes of that box only.

**Wipes:** per-ROI `dedup` mute sets and cluster caches. Disposable.
**Check:** two Dedup boxes with different mutes on one camera. A Classifier behind one sees only unmuted frames. A Dedup right after Ingest covers the whole dataset.

## 4. Open items

- The dead dot top right: probably the ROI feature box. The merge removes it either way. A screenshot would confirm.
- Camera with many products: very tall Classifier box.
- Scan depth dial and versions: postponed, as in the handover.
- Earlier open items stay: blob detector, measuring the v1.87.0 Classify speed-up, a reference point per detector target.

## 5. Caveats

- None of v1.82.0-v1.87.0 or the Chain pages has been clicked through in a real browser on real cameras. Do that before building much on top.
- Tests and checks must use temporary locations, never the real cameras or `data/picture_sorter.db`.
- Fits the north star: boxes with uniform in / out types let the later flows reuse the same toolbox.
