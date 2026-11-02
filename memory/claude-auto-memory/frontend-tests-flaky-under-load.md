---
name: frontend-tests-flaky-under-load
description: On the Linux workstation the full frontend suite fails one random unrelated test when the machine is busy; rerun that file alone and use fewer workers before suspecting the code.
metadata:
  node_type: memory
  type: project
  originSessionId: 7e7cb698-8e4a-45cb-ab47-8cb13b057e70
  modified: 2026-11-02T21:13:52.591Z
---

On the home Linux machine the full `npm test` run (vitest, 96 files) sometimes fails **one random test in a file nobody touched** (seen 2026-11-02: `DeletedByDay`, `ChainPalette` twice with "ResizeObserver is not defined" from React Flow, `PictureEditsWork`, `ClassifyView` "a deleted card fades"). Every time the file passed 5/5 or 10/10 when run alone and on the committed code. The machine was loaded (a game running, load average up to 10).

**Why:** timing races (late renders after the test's globals are removed, 1 s `findBy` waits) under CPU load, not a regression.

**How to apply:** when one unrelated frontend test is red, rerun that file alone a few times, then run the whole suite with `cd app/frontend && npx vitest run --maxWorkers=2` (or 3) before changing code. Do not stash the working tree while another test run is going in the background. Say plainly in the delivery note that a flake happened and how it was cleared. The backend suite (`.venv/bin/python -m pytest`, about 3.5 min) has not shown this.
