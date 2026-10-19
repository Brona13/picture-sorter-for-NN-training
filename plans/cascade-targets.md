---
name: cascade-targets
description: A detector behind another detector gets its own named targets, each searching inside the box of one chosen target of the first detector ("hole left detail" inside "hole left")
status: built as v1.73.0 (approved by the user 2026-10-19)
document_type: plan
last_updated: 2026-10-19
---

# Own target names in a cascade

## Problem (found with the user, 2026-10-19)
A detector behind another detector could only have targets named like the first detector's targets ("target A searches inside box A, matched by name"). The page hid *+ New target*, its chips were the parent's targets, and a drawn rectangle became a second target with the parent's name. The user wanted "hole left detail" inside the box of "hole left" (also the plan of `discussions/modules-chaining-canvas.md`).

## Decisions
- Each target of a cascaded detector has its own name and an `inside` link: the target of the input detector whose found box it searches in. A target without `inside` (made before v1.73.0) falls back to the same name.
- One parent box can hold several child targets; the link can be changed later in the right panel.
- A picture with no parent box for the linked target is skipped for that target and goes to review, as before.
- Page: *Search inside* chips (the parent's targets) choose which parent box and picture you see; below them the detector's own targets and *+ New target*. A drag in draw mode adds an example to the selected own target, or starts a new target (name next, suggested "<parent target> detail"). Choosing a parent chip that the selected own target does not belong to switches to a new target.
- Calculate points, Anchor dots and so on use the child's own names.

## Steps
1. `flow.py`: `inside` on targets (add, set, run, signature, detail with `parent_targets`); API: `POST .../targets` takes `inside`, `PUT .../targets/{name}` changes it.
2. Page (`FlowBoxView.tsx`) and panel (`FlowBoxPanel.tsx`).
3. Tests, docs, version.
