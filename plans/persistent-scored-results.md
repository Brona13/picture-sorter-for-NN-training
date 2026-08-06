---
name: persistent-scored-results
description: Persist frame-scoring results so cached classify grids render immediately
status: shipped
document_type: plan
last_updated: 2026-07-29
---

# Plan: Persist FrameScore results so the Classify grid renders on entry

> **Status — shipped & verified (2026-07-29).** Removes the click-Refresh gate whenever a cached scoring exists.

## Context

The Classify view used to start blank whenever `st.session_state` didn't already hold a scored list — the user had to click **🔄 Refresh scores** before *any* grid rendered. Session state is easy to lose: server restart, code reload, closing the browser tab. Per-frame vectors (hist / gray / ResNet embeddings) were already persisted in `score_cache`, but the final `FrameScore` (distances, leaning, margin, novelty) lived only in session state, so every fresh entry paid a click + a ~6s warm-cache recompute.

The user's directive: **whenever there is something to show, show it**. First-time vector generation is understood; every subsequent entry — same ROI, different ROI, cross-restart, even after goldens changed — must render the grid immediately from the last persisted scoring. The existing stale-goldens banner + manual Refresh remain the way to *update* stale results; nothing forces the user to click just to *see* them.

Refined by user during implementation (2026-07-29): **do not auto-compute on entry to a fresh ROI** — the first scoring of any ROI is always an explicit user click, so the user is never ambushed by a silent multi-second (or multi-minute cold-cache) compute. Only cached ROIs render automatically.

## Approach

Add a persistent cache for `FrameScore` results, one row per (camera, feature, roi_key). On view entry:

1. Load the cached row into session state (if session state is empty). Whatever is there wins, even if stale.
2. `_stale_warning` compares the stored `golden_sig` / `frames_sig` to the current values; a mismatch shows the appropriate banner but does **not** clear the grid.
3. Manual `🔄 Refresh scores` re-scores against the current goldens and overwrites the cache row.
4. If no cached row exists and no session state → today's `Click Refresh scores` cold-start hint. Explicit-only compute for fresh ROIs.
5. No goldens at all → existing `Start here` hint.

## Files touched

### `scripts/db.py` — new `results_cache` table + helpers

```sql
CREATE TABLE IF NOT EXISTS results_cache (
    camera     TEXT NOT NULL,
    feature    TEXT NOT NULL,
    roi_key    TEXT NOT NULL,
    golden_sig TEXT NOT NULL,
    frames_sig TEXT NOT NULL,
    payload    BLOB NOT NULL,    -- opaque bytes; classify.py owns the format
    ts         REAL NOT NULL,
    PRIMARY KEY (camera, feature, roi_key)
);
```

Helpers alongside `get_setting` / `set_setting`:

- `load_results(camera, feature, roi_key) -> dict | None` — returns `{golden_sig, frames_sig, payload}` or `None`.
- `save_results(camera, feature, roi_key, golden_sig, frames_sig, payload)` — `INSERT OR REPLACE` (one row per key, cache never grows unboundedly).
- `delete_results(camera, feature) -> int` — used by `purge_feature`.

`payload` is opaque bytes; no `FrameScore` knowledge leaks into `db.py`.

### `scripts/classify.py` — serialisation

- `serialise_results(results) -> bytes` — JSON per-frame: `{frame, golden, per_method: {m: {dists, leaning, margin, novelty}}}`. `MethodScore` is flat primitives, so `json.dumps` handles it directly.
- `deserialise_results(blob) -> list[FrameScore]` — inverse; missing `per_method` → empty dict (golden frames).

### `scripts/view_classify/_helpers.py` — `frames_signature`

Fingerprint of the frame set (`",".join(sorted(frames_for_feature))`), so ingest/delete of frames invalidates. Sits next to the existing `golden_signature`.

### `scripts/view_classify/render.py` — `_refresh` restructured

1. **Hydrate**: on first entry, if session state is empty, `db.load_results` → deserialise → session state (`key`, `key + "::gsig"`, `key + "::fsig"`). Malformed payload swallowed silently — the view falls back to the cold-start hint rather than blowing up.
2. **Refresh button**: `_run_and_cache(...)` computes, updates session state + all three sig keys, and `db.save_results`s the payload. DB write is wrapped in try/except so a cache-write failure never breaks the view (session state still holds the result).
3. **No auto-compute** on a fresh ROI (user's explicit decision) — if `results is None`, show `Click Refresh scores to evaluate the inbox.` and return.
4. **Stale warnings**: `_stale_warning` now checks both golden and frames signatures independently; different messages for each.

### `scripts/labels.py` — `purge_feature` cascade

`purge_feature` already dropped `labels` / `goldens` / `score_cache` / `versions` rows for a feature. Extend to also drop the `results_cache` row so a purge is truly clean.

## Verification

Manual, in `streamlit run scripts/app.py` on `pekat-cam3`:

1. Open Classify on `suspension-rod-front-left` (warm vectors). Click `Refresh scores`. Confirm a row appears: `SELECT camera, feature, roi_key, length(payload) FROM results_cache;` (was ~155 KB for 289 frames × 3 methods).
2. Stop the server, restart, reopen the same view — grid renders instantly, no click required (proven by screenshot in the session log).
3. Switch to `screw-bottom-visible` (uncached): expect `Click Refresh scores to evaluate the inbox.` hint, no compute.
4. Back to `suspension-rod-front-left`: still instant from cache.
5. Mark a new golden, re-enter view — grid still renders (from cache), stale banner appears; click Refresh → banner clears, cache row updated.
6. Verified in Python:
   ```
   from view_classify._helpers import frames_signature
   from classify import serialise_results, deserialise_results
   # Round-trip test passes; frames_signature returns a stable string.
   ```

## Design notes

- **Why cache the final `FrameScore` too** when `score_cache` already caches vectors? Because distance math over 289 × 3 methods still takes ~6s in the warm-cache case (measured). Persisting the finished result makes cross-restart entry instant, which was the whole point.
- **Why key by `roi_key` and not just feature?** The ROI box can change (ROI editor), which invalidates distances. Baking `roi_key` into the key means a moved ROI naturally misses the cache; the old row becomes orphaned but harmless (`INSERT OR REPLACE` will overwrite it if the user reverts).
- **Why store payload as `BLOB` and not `TEXT`?** SQLite treats them equivalently for JSON; `BLOB` signals "opaque to the DB" and keeps the door open for a more compact format later without a schema change.
- **Why no auto-compute for a fresh ROI?** User's explicit choice — never surprise the user with a silent multi-second compute. The click is a deliberate signal.

## Out of scope

- Any change to `_bulk.py`, `_auto.py`, `_grid.py`, or `_controls.py`.
- The `Insights` view has its own `Compute matrices` button — could later reuse this cache but is not part of this plan.
- Server-side background pre-warming (Streamlit isn't the right primitive).
