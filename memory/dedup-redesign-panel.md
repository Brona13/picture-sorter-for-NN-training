---
name: dedup-redesign-panel
description: Dedup page redesign trial, v1.31.0-v1.41.0 - right options panel, one active function, scatter as a function, picture viewer, info tips, hardware badge, product picker move; decisions, rollout rules, open points
session_date: 2026-10-16
last_updated: 2026-10-17
status: current
document_type: session-note
metadata:
  type: project
---

# Dedup page redesign (trial), v1.31.0-v1.41.0 (2026-10-16/17)

The user redesigns the app one page at a time, starting with Dedup, and will "copy the look to other pages once happy". Canonical description: `docs/current-project.md`, section *Dedup page layout and the options panel*; user-facing: README *The Dedup page*. Earlier work: [[laptop-patches-and-ux-round]].

## What exists now
- **Right options panel** (`SidePanel.tsx`, collapsible, state remembered): Embedding, Product, Feature (ROI), then function groups Clusters, Scatter, Outliers (`PanelGroup`). A card above it shows "N frames in scope".
- **One active function at a time** (tinted group + "active" tag). Opening a group only shows its settings; the group's own button (Cluster, Compute projection, Score outliers) activates it, collapses the previous one and fills the centre. Deactivated results are kept hidden (instant return), but discarded on ROI/embedding change. User said this "can change in future" (several active at once).
- **Clusters**: wheel sliders, one line of buttons (Cluster with word; Revert and Apply mute icon-only), status "N frame(s) will be muted", equal-width coloured tabs "0 (12)" ... "Unique (3)" above the shared card grid.
- **Scatter** is its own function and **no longer needs a Cluster run** (`POST /dedup/scatter` takes `method`); colour by cluster/label/outlier/nothing; selection shown in the shared paged grid, batch buttons class-coloured; changes show on the map without re-projecting.
- **Picture viewer** (`classify/FrameViewer.tsx`): overlay instead of a new tab; arrows in grid order, wheel zoom kept between pictures, ROI outline (toggle), card keys, Esc closes.
- **Info tips** (`InfoTip.tsx`) replace explanatory text; the "Hover a card and press 1 ..." lines are gone everywhere (shortcuts live in button hints).
- **Sidebar foot**: hardware badge (`GET /api/device`, three looks, click to cycle), version/date, icon-only cogwheel (second click returns to the previous page). Step bar refreshes after any change (`picturesorter:changed` event). `run.sh` prefers `.venv-rocm` (RX 7800 XT verified; `PICTURE_SORTER_VENV=.venv` forces CPU).
- Smaller: ROI editor delete confirmation inline on the right; `WheelRange` slider (wheel moves one step, page does not scroll).

## Decisions and rules to keep
- **Product picker**: one app-wide choice; the sidebar shows it on every page except those in `PRODUCT_IN_PANEL` (`App.tsx`, today `/dedup`). Converting another page to the panel layout means adding its path there and passing `products`/`onProduct`, otherwise its product dropdown vanishes. The user stressed this explicitly.
- Hardware pictures are drawn SVGs (no downloaded logos). **Pending: the user must pick one of the three badge looks**; then delete the other two and the click-to-cycle.
- Wheel sliders so far: Outliers k, Epsilon, Min points. The user approved the behaviour ("moves as expected") and wants it copied to the other sliders; not done yet.
- Panel group boxes must be identical open/closed/active (a differing box made the Cluster buttons wrap).
- React: never mix the `border` shorthand with `borderBottom` in inline styles of an element whose style changes (the coloured tab line disappeared); use per-side longhands.
- jsdom does not apply `styles.css`, so layout fixes are untested; the user reports them from the browser.

## Not verified / open
- Nothing from v1.31-v1.41 was seen in a browser by Claude; no UMAP run on real data (tests use a stand-in projection; first real UMAP run takes ~20 s).
- Open follow-ups the user may ask for: convert other pages to the panel layout, wheel on all sliders, narrow frames-in-scope card when the panel is collapsed, remove the viewer's key-hint line, clusters discarded on embedding change (today they stay with the "sliders changed" warning), undo for paint strokes, confirmation before batch label overwrites.
- Untracked `discussions/picture-sorter-ui-navigation-handover.md` (the user's own discussion, not implemented): four top-level items Overview / Management / Manipulation / Export, tool icons, a bottom status bar, one shared picture-grid component, background precompute of scatter/clustering, UI principles. Read it before any navigation work.

## Working with this user (this session)
- Dictated messages contain speech-to-text errors: "data page" and "duplication page" = Dedup, "cutter tool" = Scatter, "MD GPU" = AMD GPU, "bin icon" = the trash button, "Okay, not good" = OK / NG. Resolve by context.
- The user wants to *agree on the idea first* when a change is non-trivial ("let me know if this is clear"; "I need to talk about it first"): restate, ask the few real questions, wait. Small visual tweaks can just be done.
- Backend changes in this stretch: `GET /api/device`, `POST /dedup/scatter` (new `method`, no clustering needed). After pulling, the laptop restarts the backend.

## Git
`origin/main` = `386ffac` (v1.41.0). Pushed only on "push it". Schema v8 unchanged. Tests at the end: 351 backend, 272 frontend, `tsc` clean.
