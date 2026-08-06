---
name: ux-show-content-on-view-entry
session_date: 2026-07-29
last_updated: 2026-07-29
description: When a UI view opens, show content — don't gate on a click if the data is available
metadata:
  type: feedback
---

When the user opens a UI view (Classify, Insights, etc.), the view must
render its actual content if there is anything to show — not a "click here
to compute" gate. Gates are for the *no-data-yet* cold-start case only.
Compute cost is an implementation detail to hide behind caches; the user
should not experience it as a click.

**Why:** UX tops perceived cost. Their own words (2026-07-29): *"When I
choose a UI view, I want to see a content (if there actually is something
to show based on logic and flow). This means: I want to see the grid
populated. I understand the first time generation of vectors and all. But
for any other time, it can show the latest state (persisted). ... I don't
really measure 6 secs of waiting. I understand your perspective that it's
not that much when doing a real life work with this tool. User experience
tops that."*

**How to apply:**
- When designing any view, ask: "if this view has ever been populated
  before, does it render immediately on entry?" If no, persist the
  necessary state (see [[plan-file-location]] → `persistent-scored-results`
  for the FrameScore pattern) rather than requiring a click.
- Reserve explicit `Refresh` / `Compute` buttons for two cases: (1) the
  cold-start case where no cache exists yet — first scoring of a new ROI
  is an explicit user click, never a silent multi-second auto-compute
  (this refinement came out of the same session); (2) an updated-state
  case where the user marked new goldens / ingested new frames — the
  existing "stale" banner tells them to click.
- Do not add a manual gate "just because scoring takes a few seconds" —
  cache the output and let it look instant.

Applies across views, not only Classify. Any new view (Insights was one
this session) should hydrate its own results cache on entry once shipped
past MVP.
