---
name: chain-canvas-and-classify-session
description: Session 2026-10-18 (v1.51.0 to v1.63.2) - the Chain page, camera delete, and a long round of Classify work (numbers, search, sweeps, options panel, product rename); decisions, rules, what is unverified, what comes next
status: current
document_type: memory
session_date: 2026-10-18
---

# Session 2026-10-18: Chain page and the Classify page (v1.51.0 to v1.63.2)

Everything below is committed and pushed (`origin/main` = `d765ba5` for the code; the docs commit that saves this session follows it). **None of it has been clicked through in a browser**: the Chrome extension was never connected, so every feature is covered by backend tests (480) and frontend tests with a mocked API (519) only. First thing next session: start `./run.sh`, hard-refresh (Ctrl+Shift+R) and look.

## What was built, by version

| Version | What |
|---|---|
| 1.51.0 | **Chain page**: boxes = Ingest + ROI instances, arrows derived from the ROIs, one handle per product, layout in `settings` key `chain.canvas`, delete with a preview (React Flow, new dependency `@xyflow/react`) |
| 1.51.1 | Fix: React Flow needs its size changes applied (`applyNodeChanges`), otherwise the boxes stay invisible |
| 1.52.0 | **Delete a camera** on the Overview (typed-name confirmation, one transaction over every table with a `camera` column, the folder, cached vectors only that camera uses) |
| 1.53.0 / 1.53.1 | Classify box after the product ROI; the product handles moved to it. Opening a page from the chain sets the product scope (otherwise Classify showed another ROI) |
| 1.54.0 / 1.54.1 | Classify **Grid / Scatter** switch over a shared `ScatterWorkbench`; map appears if cached (`GET dedup/scatter/cached`); grid settings shared with the Grid |
| 1.55.0 | ROI editor opened from the chain is locked to one ROI (`/roi?focus=`) |
| 1.56.0 / 1.56.1 | Classify box for every feature ROI; short *ROI editor* / *Classify* buttons on every ROI box |
| 1.57.0 / 1.57.1 | **Outliers** in the switch; Classify locked to the ROI (`/classify?focus=`), Back to chain on the nav line |
| 1.58.0 to 1.58.3 | **Search by file name** (pager, every grid; whole camera in Classify); Classify says less; Refresh scores and its status on the nav line |
| 1.59.0 | Clickable numbers, **live pictures only** (not deleted, not muted for the ROI) |
| 1.60.0 to 1.60.2 | **X clears, Delete sweeps, deleted cards fade and stay**; the viewer shows the product of a found picture (Product row first on the label line) |
| 1.61.0 | No manual Mute; **Show again** for hidden pictures; the outside-scope warning moves to the zoom line; *Feature* caption |
| 1.62.0 | **Options panel** on Classify (`PanelPortal`); Grid, Scatter and Outliers controls live there |
| 1.63.0 to 1.63.2 | **Rename a product** without losing labels or ROIs; **Rank using** in the top bar; no key numbers on the label buttons |

## Rules agreed with the user (do not undo without asking)

- **The Chain is a view of the ROIs**, never a second source of truth. Arrows, boxes and Classify boxes are derived; only positions, display names and the viewport are stored. A product is a *class* of the product-sorting ROI (so that ROI's Classify box has the product handles); a feature is scoped by arrows from those handles (the ROI's `products` list) or by its name `<product>::<roi>` (a locked arrow). A feature ROI is drawn on the whole picture; the product ROI only separates products.
- **Locked pages**: opening ROI editor or Classify from a chain box locks the page to that ROI (no selector); the menu pages keep their selector.
- **Camera delete** has no trash and no undo; it needs the typed name; a running job blocks it.
- **Classify numbers** count live pictures only (not deleted, not muted for the ROI); Deleted/Muted have no boxes. Other pages (Status, version records) still use the shared `labels.counts`, which counts every picture.
- **Search** covers the whole camera (deleted, muted, outside-scope included). Found pictures outside the ROI's scope: red frame and hint, OK/NG locked until the product fits; muted: dark grey dashed frame. The viewer shows the **Product** row (feature ROIs only), then the **Feature** buttons, then **Show again** for hidden pictures; the warning is one line on the zoom line so nothing changes height. **No manual Mute** (Delete gets rid of a picture, the duplicate step mutes).
- **Sweeps never overwrite a label.** A class key fills unlabeled cards, `0`/`X` clears labeled non-golden cards, **Delete** deletes unlabeled non-golden in-scope cards only. Goldens are never swept. The same on every label grid and Verdict (X); the Detector keeps its red cross for X and Delete sweeps its undecided cards.
- **A deleted card fades and stays in place** (with Restore) until the grid is turned (page, size, columns, View, search, new list); Classify updates the card locally, the lists do it in `PictureGrid`, the Detector drops its deleted ghosts on a grid change.
- **Label buttons show no key numbers**; the key is in the hover hint.
- **Rename a product** only through `products.rename_products` / `db.rename_products` (one transaction); renaming by editing the class list loses labels and ROI connections.
- **Rank using** is a top-bar picker (Classify page only, hidden with fewer than two methods), shared through `RankContext`.

## Open and next

- **Proposed, not built**: per-product outlier scoring (a *Pictures* choice in the Outliers panel: All / Labeled <class> / Unlabeled; neighbours searched inside the group). See `docs/current-project.md` item 0b.
- **Look at it in a browser**: the 300 px options panel with the bulk tools, the React Flow handles of the Classify boxes, how sweeps feel (cursors, once-per-stroke), red/grey frames, the fade-and-stay.
- **Easy access to hidden and deleted pictures** (item 0a): one obvious place to list and restore them.
- Chain next steps: filter and detector boxes, Merge box (late; never blends classical and ResNet), run-the-whole-chain, Overview rework. Bundle size warning (680 kB); no stroke-level undo.
- Known flaky tests: `test_clean_schema.py::...test_parallel_first_connects_all_succeed` (database is locked) and one `DedupView.test.tsx` clustering test under full-suite load.
- Laptop: pull, `npm install` (new dependency `@xyflow/react`), rebuild the frontend, restart the backend. No schema change this session (still v8).

## Working with this user (this session)

- Voice-dictated; resolve mishearings from context ("course" = colours, "nose cutter outliers" = Scatter, Outliers, "star okay" = ⭐ OK).
- They iterate in short rounds and decide fast; when they write "give me your understanding, and if it's fine build", list the understanding, the open and contradicting points, and **build only when there are none**; otherwise ask in plain text with my recommendation.
- Option pop-ups (`AskUserQuestion`) were dismissed twice with "I want to clarify"; plain-text questions with a recommended default work better.
- Tool prompts were sometimes rejected by an accidental click ("clicked no by mistake"); just repeat the call.
- Push only on "push it" or "commit and push"; commit after tests exit 0.
- A mistake to avoid: `cd ..` inside a chained command left the next commands in the wrong folder (version bump and docs silently skipped, `npx tsc` tried to install a package). Start every chained command with `cd /home/brona/Documents/Obsidian_Vault/Picture_Sorter_for_NN_Training`.
