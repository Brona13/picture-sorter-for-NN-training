---
name: persistent-grid-settings
description: Persist grid page size and column settings separately for each ROI
status: shipped
document_type: plan
last_updated: 2026-07-29
---

# Plan: Persist Per page + Columns per ROI

> **Status — shipped & verified (2026-07-29).** Depends on the existing `settings` table added in [classify-and-versioning](classify-and-versioning.md).

## Context

The Classify grid has two grid-shape controls: `Per page` (12/24/48/96) and `Columns` (3/4/5/6/8). Different ROIs have different aspect ratios — a portrait-format ROI wants more columns per row than a landscape one — so the right choice is per-ROI, and the user re-tuned it every session. Streamlit selectbox `key=` already persisted the value across reruns within a session, but not across server restarts.

Intended outcome: pick `Per page` / `Columns` once per ROI, forever. Choice survives restarts, ROI switches, and browser reloads.

## Approach

Use the existing `settings` table (schema in [db.py](../scripts/db.py); helpers `db.get_setting` / `db.set_setting`). One row per (camera, key), where key is namespaced as `grid.perpage.<feature>` / `grid.cols.<feature>` — the feature name is unique per camera, so this covers per-ROI scope.

On render:

1. `st.session_state.setdefault(<widget_key>, _load_grid_setting(...))` — reads from DB the first time the widget is seen this session; subsequent renders come from session state.
2. Render selectbox with `key=<widget_key>` — Streamlit uses the pre-seeded value.
3. `_persist_if_changed(camera, feature, kind, value, session_key)` — writes to DB only when the value differs from an in-session "last written" marker, so idle reruns don't hit SQLite.

Fallback rules in `_load_grid_setting`: if the stored value is missing, unparseable, or not in the current options list, use the default (24 / 4).

## Files touched

- `scripts/view_classify/_grid.py` — two helpers (`_load_grid_setting`, `_persist_if_changed`) and their invocations around the settings selectboxes.

No schema change (the `settings` table already exists), no changes elsewhere.

## Verification

1. Change `Columns` on ROI A to 6, `Per page` to 48.
2. Switch to ROI B — its own persisted values (or defaults) load. Change B's `Columns` to 4.
3. Switch back to ROI A — 6 / 48 restored.
4. Stop the Streamlit server, restart, reopen ROI A — 6 / 48 still there (proves DB read path).
5. `SELECT camera, key, value FROM settings WHERE key LIKE 'grid.%'` shows one row per (camera, feature, kind).

Verified during implementation by seeding a value directly via `sqlite3`, reloading the app, and confirming the selectbox rendered the seeded value.

## Related

Later paired with [classify-ui-tune](classify-ui-tune.md)'s one-line control row: both the top and bottom `Per page` / `Columns` selectboxes read from the same shared session-state key that persists via the mechanism described here.
