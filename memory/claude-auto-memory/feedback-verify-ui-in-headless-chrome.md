---
name: feedback-verify-ui-in-headless-chrome
description: Layout and pointer bugs on the pages need a real browser check (jsdom tests miss them); how to run one here without the Chrome extension
metadata:
  type: feedback
---

For a UI bug about sizes, scaling, zoom or where the pointer lands (the user said "double check, fix it"), reproduce and verify it in a real browser, not only with vitest: two detector-page bugs (a stage wider than its picture, a half-pixel convention) passed all 560 jsdom tests.

**Why:** jsdom has no layout; `getBoundingClientRect` is mocked, so the tests agreed with the broken code.

**How to apply:** the Claude-in-Chrome extension was not connected, but `/usr/bin/google-chrome` is installed and `.venv` has `websockets`: start a temporary server (`CURATION_CAMERAS_ROOT` and `CURATION_DATA_DIR` in the session scratchpad, port 8765, `npm run build` first), seed a camera and a synthetic picture through the API, drive headless Chrome over the DevTools protocol (`--headless=new --remote-debugging-port`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`), measure boxes with `getBoundingClientRect` and compare with what the API stored; read the screenshot with Read. Never use the real `cameras/` or `data/`. Stop the server with `fuser -k 8765/tcp`, not `pkill -f` (it matched and killed the shell itself). Related: [[feedback-measure-and-show-numbers]].
