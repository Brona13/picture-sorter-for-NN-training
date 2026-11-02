---
name: feedback-stale-page-after-update
description: A bug report that code and tests cannot reproduce may be an old browser page left open across an app update; ask for a hard refresh / recreate first
metadata:
  type: feedback
---

On 2026-10-25 the user reported "can't connect ROI product to a detector"; code, tests and the live API all allowed it. They then found it was an old Chain view that the app had updated underneath, and recreating the box fixed it.

**Why:** the app is updated often (several versions a day) while pages stay open; old pages call old endpoints or hold old box shapes. I spent a long time on a browser reproduction before asking.

**How to apply:** when a connect/save/404 problem appears right after a pull or restart and static reading finds nothing, first ask for a hard refresh or to recreate the box, and check the Log page (`GET /api/logs`) for 404s from old endpoints, before building a browser repro. Related: [[feedback-verify-ui-in-headless-chrome]].
