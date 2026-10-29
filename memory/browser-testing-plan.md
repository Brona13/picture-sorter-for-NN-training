---
name: browser-testing-plan
description: Plan (not built) for a reusable, no-interaction browser test harness on Linux and later Windows; the ad hoc method used so far, the proposed design, open decisions
status: current
document_type: memory
session_date: 2026-10-29
---

# Browser testing without user interaction (discussed 2026-10-29, nothing built yet)

The user had this when the app was written in Streamlit and asked for it again for the React + FastAPI app, first on the home Linux machine, possibly on Windows later.

## What exists today
- No reusable harness. When a UI check is needed Claude writes a throwaway script: temporary server on temp `CURATION_CAMERAS_ROOT` / `CURATION_DATA_DIR`, `npm run build` first, a synthetic camera seeded through the API, headless `/usr/bin/google-chrome` driven over the DevTools protocol with `websockets` from `.venv` (`Input.dispatchMouseEvent`, `Page.captureScreenshot`, `getBoundingClientRect`). Details and the `fuser -k <port>/tcp` stop rule: the user-level memory "Verify UI in headless Chrome".
- jsdom tests (vitest) have no layout, so they miss sizing / pointer bugs; a real browser is the only check for those.
- Nothing in the repo uses Playwright, Puppeteer or Selenium.

## Proposed design: `tools/browser_check/`
- **Fixture:** builds the frontend if `dist` is missing, starts uvicorn on a free port with temp directories (never the real `cameras/` or `data/picture_sorter.db`), seeds a small synthetic camera (a few pictures, a Classifier, a detector target) via the API, tears everything down at the end.
- **Driver helpers:** open a page, click / drag / type by selector, wait for the UI to settle, measure `getBoundingClientRect`, screenshot (Claude reads it), collect console errors and failed requests.
- **Smoke test:** visit every main page (Chain, Dedup, Classify, Log, ...), fail on a console error or a blank page. Then scenarios: draw a line on the Chain, paint labels in Verdict, detector -> Picture edits link.
- **Run:** `.venv/bin/python tools/browser_check/run.py`, separate from `pytest` (needs Chrome, slower).
- **Delivery:** v1.131.1 (the repo rule bumps `VERSION` for any change), README section, a short note here.

## Decision leaning: Playwright
- Playwright's Python API is the same on Linux and Windows; `pip install playwright` into `requirements-dev.txt`; use the installed browser (`channel="chrome"`, or `msedge` on Windows, which always has it) so no browser download, which matters behind the work proxy.
- Alternative: raw DevTools over `websockets` (no new dependency, but Chrome discovery, launch and waits would be written and maintained per OS). Judged more costly for a harness meant to grow.
- Keep OS-specific parts thin from the start: `pathlib`, `subprocess`, a free-port lookup, start uvicorn from the venv's Python directly (not `run.sh` / `fuser`); use `app/frontend/dist` as is when npm is absent (on the Windows laptop the dist is the delivered zip).
- Windows is untestable from here: possible snags are the proxy / antivirus on `pip install`, script execution policy and a locked-down browser profile. Treat Windows as "run it there and fix what breaks".

## Open decisions (waiting for the user)
1. Driver: Playwright (recommended) or raw DevTools.
2. Linux-only first? (proposed yes)
3. Which page or bug to cover first, beyond the smoke test + Chain scenarios.
4. Go-ahead to build; the user has not said "build it" yet.

## Why this matters now
The recent UI work (palette strip, drag preview on Windows, class dots, Merge dragging, Verdict painting, Log tables, start-up screen, Chain look) has never been checked in a real browser; see [[2026-10-29-windows-work-chain-palette-log-startup-session]] and [[2026-10-28-classifier-scope-verdict-boxes-merge-session]].
