---
name: streamlit-gotchas
session_date: 2026-07-27
last_updated: 2026-07-29
description: Hard-won Streamlit quirks — image 404s, st.markdown strips img, selectbox keys, per-button CSS, redundant st.rerun resets widgets, mirrored widgets
metadata:
  type: reference
---

Streamlit behaviours that cost real debugging time in this project. Check here before re-diagnosing a rendering oddity.

**1. `st.image` can 404 in the ROI editor — use an inline `data:` URI instead.** Thumbnails rendered with `st.image` in `view_roi_editor.py` came back **404** for the *first two* images on every render (`complete=true`, `naturalWidth=0`, broken icon), while later ones loaded. It is positional, **not** aspect-ratio related (it survived making every thumbnail an identical 128×128 square). Cause: this view's `streamlit-drawable-canvas` shim registers the canvas background **by hand** via `runtime.get_instance().media_file_mgr.add(...)`, which disturbs the
media manager's per-rerun bookkeeping for files added around it. Fix: `ui_common.thumb_data_uri()` embeds the JPEG as base64 and bypasses the media manager entirely. *Classify's grid uses plain `st.image` and is fine* — the problem is specific to the canvas view.

**2. `st.markdown(..., unsafe_allow_html=True)` strips `<img>`; `st.html()` does not.** The tag vanished silently (the surrounding divs survived, the image did not). For inline images in custom HTML use **`st.html()`**.

**3. Driving a `st.selectbox` by automation:** typing appends to the current value (typing "Golden" into a box showing "All" yields "AllGolden" and matches nothing). Clear it first (triple-click / ctrl+A), type a fragment, then **Down arrow, then Enter** — Enter alone does not commit. Clicks on the popover option are unreliable; `computer` coordinates are **real viewport** pixels, while screenshots come back downscaled (800×500 for a 1600×1000 viewport).

**4. Building a card layout (used by the Defined ROIs list).** Streamlit 1.59 has everything needed natively: `st.container(border=True)` draws the card, `st.columns(..., vertical_alignment="center")` aligns a row, and `st.button(..., type="tertiary")` gives a borderless icon button. For the product multiselect to read as bare chips rather than a form field, one `st.html("<style>…")` block targets `[data-testid='stMultiSelect'] div[data-baseweb='select'] > div` (transparent background/border) and `span[data-baseweb='tag']` (chip colour — the theme's accent is red, which reads as a warning for what is only scope info). Cosmetic only: if those hooks are renamed the widget just falls back to default styling.

**5. `.claude/launch.json` sets `--server.fileWatcherType none`,** so code edits need a server restart (`preview_stop` + `preview_start`) — the app will otherwise keep running stale code.

**6. Colouring one primary button but not others (no CSS-text-selector).** CSS cannot select a button by its text content, so a `<style>` targeting `button[data-testid="stBaseButton-primary"]` hits *every* primary button (Refresh, all class-active buttons, etc.). To tint one — e.g. active OK green while active NG stays red — inject a script via `st.components.v1.html(html, height=0)`. Inside that iframe reach `window.parent.document`, add a `<style>` block once, and a MutationObserver toggles a marker class on the matching buttons (`b.getAttribute('kind') === 'primary' && b.textContent.trim() === 'OK'`). Done this for the OK button in `view_classify.py` (`_OK_TINT_JS`). `st.html` with `<script>` will NOT work — inline scripts inserted via `innerHTML` don't execute per HTML5 spec; only `<style>` does.

**7. Never call `st.rerun()` inside a button-click branch after mutating state — Streamlit already reruns from the click.** Redundant `st.rerun()` on top of the automatic click-rerun caused widgets rendered *below* the button (e.g. the *Columns* / *Per page* selectboxes in the Classify grid) to display their persisted session_state value in the DOM but evaluate to their default in Python — so the input showed `6` while `n_cols` came out `4` and the grid rendered four-per-row. Fix in `view_classify/render.py::_refresh`: write to session_state and let the click's own rerun carry the code below the button branch through the same run.

**8. `ConnectionResetError: [WinError 10054]` / `_ProactorBasePipeTransport._call_connection_lost`** in the console is **harmless** Windows asyncio noise when a websocket drops (tab closed, refresh, server stopped). No frames from `scripts/` appear in it. Silencing needs a CPython monkey-patch — not worth it. The *real* `use_container_width` deprecation warning was fixed separately.

**9. Two widgets that must show the same value — pre-render mirror + on_change callback.** Widget keys are globally unique, so two selectboxes that need to reflect the same state (e.g. top + bottom pagination bars sharing `Per page` / `Columns`) can't share a key. The working pattern (used in `view_classify/_grid.py::_control_row`):
- **One shared key** holds the source of truth (`f"perpage::{camera}::{feature}"`), hydrated once from persistence via `st.session_state.setdefault`.
- **Two widget keys** (`::top` / `::bottom` suffixes) — one per rendered widget.
- **Before either widget renders each script run**, mirror the shared value into both widget keys: `st.session_state[widget_key] = st.session_state[shared_key]`. Streamlit's rule "cannot set session_state[X] after widget X instantiated" is a **same-run** constraint; pre-render assignment is legal and is what the pattern relies on.
- **`on_change` callback** on each widget copies its own value back into the shared key + persists: `partial(_sync_setting, camera, feature, kind, shared_key, position)`. Streamlit callbacks don't accept positional args, so `functools.partial` is the way.
- Result: changing either widget syncs the other on the next rerun (fast enough to feel instant). No callback storm, no widget-key collision, one line for persistence.
