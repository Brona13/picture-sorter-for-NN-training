---
name: session-handover-2026-10-22
description: Chain redesign decisions from the 2026-10-22 voice discussion - merged Classifier box, uniform outputs, Dedup box, module palette, fixed box sizes, Picture edits panel, line warnings
status: draft-for-next-session
document_type: handover
created: 2026-10-22
related: current-project.md, north-star-handover.md, session-handover-2026-10-21.md
last_updated: 2026-10-22
---

# Handover: Chain redesign (discussion 2026-10-22)

Nothing here is built. This was a design talk (voice mode). Code state is still v1.87.0 as in `docs/current-project.md`. Use this as the work order for the next coding session. Items marked **Open** were not answered by the user.

User preferences for this work: short sentences, one problem at a time, no opening compliments, do not remind him about switching modes.

## 0. Ground rules from the user

- **Test data is disposable.** No migration work. If a change wipes something, say what it wipes, then go ahead. Storage may be restructured cleanly instead of carrying old shapes.
- **Move functions from the old menu into Chain boxes**, step by step. The Chain becomes the main way to work.
- **Every box is defined by what goes in and what comes out.** The Chain only checks that types match. Any box can be placed anywhere, several times, also behind boxes of the same kind.

## 1. Merged Classifier box (ROI + product + feature + Classify -> one box)

- One box type, named **Classifier**, with a **Mode** dropdown: **Product** or **Feature**.
- Replaces the pair "ROI box + Classify box". The separate Classify box goes away. The Classify button, the ROI editor and the Classify page become the page of this one box (right panel holds the settings, as with Detector and Picture edits).
- The panel also carries the settings that exist today on the ROI side: product scope, detector anchor, Picture edits input (`roi.input.<feature>`).
- Product mode: sorts frames into product classes. Feature mode: classifies OK / NG, input is a product output or the whole camera.
- Likely cleanup: the dead output dot on the ROI feature box (added v1.63.3 for the fixed arrow to its Classify box) disappears with the merge. The user described "a dot top right that has no use"; this is Claude's best guess for which box, **unconfirmed**. If it is another box, he will send a screenshot.

## 2. Uniform outputs (all boxes with classes)

- One **dot per class** plus one **all dot** (top right).
  - Product mode: one dot per product.
  - Feature mode: two dots, OK and NG.
- Drawing from the **all dot** passes everything on. Drawing from class dots passes only those classes (two lines from two of three products = two classes out of three).
- This replaces the earlier idea of an "output all / only labeled" toggle: the dot you draw from decides.
- **Open:** does the all dot include unlabeled pictures while class dots carry only labeled ones? (Claude's proposal, not confirmed.)
- Make the same behaviour apply to other modules as far as possible.

## 3. Dedup box (new, picture in -> picture out)

- Dedup becomes a Chain box. Scatter, Clusters and Outliers become views inside its page (like Classify's Grid / Scatter / Outliers).
- Placeable anywhere in the chain; works on whatever picture reaches it (whole frame after Ingest, crop after Picture edits or a Classifier). Embedding choice sits in its panel.
- **Mutes belong to the box**, not to the ROI. Two Dedup boxes can hold different mutes. Muted pictures are hidden by default, with a **Show muted** toggle.
- Today mutes are per ROI (`dedup` mute sets, cluster Apply reconciles per ROI), so storage moves to per box.

## 4. Module palette in the Chain's right panel

- Replace the "+" buttons with a **grid of square, larger tiles** in the right pane, each with the drawn two-tone icon (as `ToolIcon.tsx`) and a short label; about 2-3 per row. Group by input / output type.
- **Draggable from the start** (not a later step): a ghost of the final box follows the pointer over the canvas, and the box is created where it is dropped. Click to add should also work.
- **No automatic lines at all.** A new box is placed unconnected. This also removes the existing exception (first Crop/Detector in an empty flow graph joined to Ingest, `flow.create_node`). One rule everywhere; the user draws every connection.

## 5. Box size and look

- **One fixed size per box type**, never changed by content. Sizes may differ between types. **One color per type.**
- Picture edits box: no step list. It shows a **crop icon** and a **filter icon**, each with a small number badge when used more than once (three filters = filter icon with 3). An icon appears only if that step type is in the list. The full list stays in the right panel.

## 6. Picture edits right panel

- A collapsed step is **exactly one line**: grip, name, expand arrow, **on/off toggle**. Today it takes three lines. The operation dropdown moves into the expanded part.
- The selected step opens by default, the others are collapsed.
- **Open:** may several steps be open at once, or only one?
- **Bypass toggle:** a switched-off step keeps its place in the order, is skipped when processing, and is dimmed on its line. The toggle counts as a change in the box signature (a detector behind goes stale), same as editing a step.

## 7. Lines: delete and reconnect warnings

- **Delete:** select the line (turns blue), press Delete. An **overlay** states what would be lost or changed (source box, target box, effect, e.g. the ROI goes back to the whole camera, a detector behind it loses its input). **Enter confirms, Esc cancels.** Deleting a line removes only the connection, so the text describes behaviour changes.
- **Reconnect:** dragging a line onto a box whose input is already taken (A->B exists, user draws A->C... i.e. C already has an input and gets a new one) shows the same overlay: the old input is replaced and what changes downstream. The new line is made only on confirm. Cancel leaves the old line untouched.
- **Rule (user corrected Claude here):** an **output can feed any number of boxes**, so a second line from the same output removes nothing (one Picture edits box can feed two Classifiers). Only an **input that accepts one source** is limited, and only then is anything replaced and the overlay shown. Never remove anything by default. Note: Calculate takes two points, so "one input" applies per input slot, not per box.

## 7b. Menu consequences (Claude's reading, not fully confirmed)

- Redundant once the Classifier box exists: ROI editor, Classify page. Later, as they become boxes: Detector, Edge angle, the Dedup pages (Scatter, Clusters, Outliers).
- Probably stay: Overview, Ingest, Verdict, Versions.

## 8. Suggested order of work

1. No-automatic-lines rule and the line delete / reconnect overlays (small, independent).
2. Picture edits panel: one-line steps, bypass toggle, fixed box size with icon badges.
3. Module palette with drag and drop.
4. Merged Classifier box (storage change, Mode, uniform output dots, anchor and input settings in the panel).
5. Dedup box with per-box mutes.

## 9. Caveats

- None of v1.82.0-v1.87.0 or the Chain pages has been clicked through in a real browser on real cameras (see `current-project.md`, item 000 and 1). Check that before building much on top.
- Open items from earlier sessions stay open: blob detector, measuring the v1.87.0 Classify speed-up, a reference point per detector target.
- Related north-star direction (labeled import, golden suggestion, anomaly detection): `north-star-handover.md`. Boxes with uniform in/out types fit it, since later flows reuse the same toolbox.
