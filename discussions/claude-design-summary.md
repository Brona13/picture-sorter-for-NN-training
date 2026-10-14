---
name: claude-design-summary
description: Summary of what Claude Design is and how it could be used for the Picture Sorter UI
status: current
document_type: recommendation
last_updated: 2026-10-14
---

# Claude Design: summary for the Picture Sorter app

## What it is
- Separate Anthropic Labs product (research preview, launched April 2026).
- You describe what you want, it builds a visual prototype on a canvas (UI mockups, slides, one-pagers), then you refine via chat, inline comments, direct edits and sliders.
- Export options include HTML/CSS/JS and a handoff bundle that a coding agent (Claude Code) can build from.

## What it changes
- Not only restyling (colors, spacing, typography).
- It can also restructure layout: grouping related elements, changing what is prominent, reordering the flow on a screen.
- Example for this app: "camera creation and ingestion as one combined, prominent view".
- The more structure you provide (real components, step-indicator concept), the less it invents its own information architecture.

## Consistency across screens
- Stay in one Design project when moving from screen to screen.
- Tell it to keep the same style system (colors, spacing, components).
- Works like inherited CSS conceptually, but it is not literal CSS inheritance.
- Note: this behavior was described from general understanding, not verified in docs. Check in practice.

## Division of work
1. Claude Code: builds the functional skeleton (routes, components wired to real data, working buttons). Ugly is fine.
2. Claude Design: reworks look and layout using that skeleton as reference.
3. Export from Design, hand it back to Claude Code.
4. Claude Code wires it to the FastAPI back-end and fixes anything functionally broken.
5. Continue developing in Claude Code, keeping the Design look.

## What to hand to Design
- Component files of the target screen (start with camera creation + ingestion view).
- Shared layout/wrapper and theme/stylesheet files those components use.
- Routing file, so it understands how screens connect.
- Skip: FastAPI back-end files.

## Suggested workflow
- One screen at a time, not the whole app.
- Candidate order: camera + ingestion view, then ROI overview hub, then the sequential pipeline with persistent step indicator.
- Describe the specific change wanted per screen.
- Whether Design can connect the repo directly was not verified. Otherwise export or paste the files.
