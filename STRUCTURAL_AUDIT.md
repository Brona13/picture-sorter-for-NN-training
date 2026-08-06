# STRUCTURAL_AUDIT

Read-only audit of the codebase's structure. Focus: layout, state, duplication, dead code, Streamlit-specific performance hazards, and the file/function sizes that would drive any refactor decision. Findings are grounded in specific files and lines (`path:line` where useful). Where I infer intent rather than read it, I say so.

---

## 1. Current file / module layout

### Under `scripts/`

Application entry point + view dispatch:

| File | Lines | Responsibility |
| --- | ---: | --- |
| `app.py` | 110 | `st.set_page_config`, sidebar (camera + optional product + view radio), dispatch into one of seven view modules under `datamodel.render_snapshot()` and `perf.trace(...)`. Guards `db.DatabaseResetRequired`. |
| `config.py` | 81 | Paths (with `CURATION_CAMERAS_ROOT` / `CURATION_DATA_DIR` overrides), class defaults, HSV bins, metric families, embedding config, cache batch sizes. Purely constants and env parsing. |
| `engine.py` | 15 | One function: `resolve_roi(camera, feature)`. Also **imports `curation`** at module scope so other callers can go through `engine.curation.load_image` (used by `versions.py`, `ui_common.py`, `view_roi_editor/_canvas.py`). |
| `perf.py` | 164 | Opt-in performance tracing (spans + counters), independent of Streamlit. `contextvars`-scoped current trace. Optional JSONL emitter. |
| `ui_common.py` | 366 | Shared presentation: thumbnails (two bounded LRU caches), class colors + bars HTML, `ScoringProgressUI`, `editor_display_width` (via `streamlit_js_eval`), session-state key conventions, fabric-rect conversions. |

Domain and persistence:

| File | Lines | Responsibility |
| --- | ---: | --- |
| `roi.py` | 106 | `ROI` dataclass: (de)serialization, `full_frame`, pixel resolution, `crop`. Only depends on `numpy`. |
| `datamodel.py` | 341 | Path helpers, cameras/frames/ROI loaders, feature composition (`::`), product/quality feature scoping, render-scope snapshot cache (`ContextVar`), `invalidate_frames` / `invalidate_rois` / `invalidate_product_membership`. |
| `db.py` | 555 | SQLite schema (all tables + all indexes), schema-version guard, connection helper. CRUD for frames, settings, results cache, cluster snapshot, scatter cache, deleted frames, dedup mutes. Almost every function opens and closes its own connection. |
| `labels.py` | 354 | Hash maps, `set_label` / `clear_label` / `set_labels_bulk` / `mark_golden` / `unmark_golden` (each transactional with the golden invariant). Read helpers: `current_labels`, `current_goldens`, `current_states_for_features` (bulk), `counts`, `purge_feature`. |
| `versions.py` | 257 | `freeze`, `list_versions`, `summaries`, `revert`, `export`. Depends on `engine.curation.load_image`. |
| `ingest.py` | 448 | Chunked SHA-256 hashing, staging via `NamedTemporaryFile`, upsert into `frames`, structured progress events, folder scan (non-recursive), catalog rebuild. |

Scoring / analytics:

| File | Lines | Responsibility |
| --- | ---: | --- |
| `curation.py` | 164 | Classical feature extraction (HSV histogram, standardized grayscale) + distances (Bhattacharyya, MSE, `1 - SSIM`) + weighted combination. Also carries higher-level `extract_features`, `build_reference_features`, `score_against_golden` — see dead-code section. |
| `embedding.py` | 176 | Lazy torch import (`_ensure_torch`), `available()`, backbone registry (resnet18 / resnet50), bounded batching with automatic halving retry on `RuntimeError`, cosine distance. |
| `classify.py` | 653 | The big one. Score-cache batched load, per-frame feature preparation (with progress), bounded decoded vector groups, classical `ThreadPoolExecutor`-parallel pair comparisons, matrix-vectorized neural distance, JSON serialise/deserialise for the persistent `results_cache`, `stats_for` per method. |
| `dedup.py` | 296 | `fetch_embeddings` (thin wrapper around `classify.fetch_vectors`), DBSCAN clustering, per-cluster representative selection, `apply` reconciling the `dedup_mute` set + writing a `cluster_snapshot` for the Classify view. |
| `scatter.py` | 149 | 2D projections via UMAP/t-SNE with cache round-trip. |

Views (Streamlit render layer):

| File | Lines | Responsibility |
| --- | ---: | --- |
| `view_status.py` | 74 | Metrics + one bulk-computed per-feature dataframe. |
| `view_ingest.py` | 155 | Upload form, folder-import expander, live status widget, maintenance expander. |
| `view_dedup.py` | 557 | Feature/settings picker, clustering, 2D scatter (Plotly), per-cluster expander with representative picker, apply/clear panels. |
| `view_insights.py` | 137 | Feature picker, per-method confusion matrix table + accuracy. |
| `view_versions.py` | 135 | Freeze form, history dataframe, per-version actions (revert / export). |
| `view_classify/` | 1378 total | Split into 8 files (see below). |
| `view_roi_editor/` | 768 total | Split into 8 files (see below). |

`view_classify/`:

| File | Lines |
| --- | ---: |
| `__init__.py` | 16 (re-exports `render`) |
| `_styles.py` | 57 (OK-green tint JS) |
| `_helpers.py` | 37 (session keys, signatures, leaning HTML) |
| `_controls.py` | 127 (Show/Rank/Order controls + filter/sort logic) |
| `_bulk.py` | 86 |
| `_auto.py` | 118 |
| `_suggest_goldens.py` | 238 |
| `_grid.py` | 437 (pagination + cards + buttons; contains `@st.fragment`) |
| `render.py` | 263 (orchestrator: refresh, cache hydration, delegate) |

`view_roi_editor/`:

| File | Lines |
| --- | ---: |
| `__init__.py` | 19 |
| `_canvas.py` | 81 (shim, `HAS_CANVAS`, background renderer) |
| `_styles.py` | 14 |
| `_headline.py` | 72 (HTML card headline) |
| `_draw.py` | 119 |
| `_edit.py` | 105 |
| `_roi_list.py` | 194 |
| `render.py` | 164 (orchestrator) |

Miscellaneous:

- `reset_database.py` — CLI to remove the DB + legacy `features/` and `logs/manifest.jsonl` / `logs/ingest_index.json` under each camera.
- Ten `benchmark_*.py` scripts — CLI-only performance harnesses using synthetic fixtures. Not imported by the app.

### Tests (`tests/`)

14 test files, all `pytest`-style. Coverage skews heavily toward the scoring pipeline: batching, progress events, streaming, thumbnail cache, result serialization, end-to-end flow. Almost no tests touch the view modules directly.

### Storage locations

- `cameras/<camera>/unsorted/` — source frames (immutable).
- `cameras/<camera>/rois.json` — ROI definitions.
- `cameras/<camera>/exports/…` — generated PNG cutouts per version.
- `data/picture_sorter.db` — one SQLite database, schema version 2.

---

## 2. Where state lives

### Filesystem
- Source frames (`cameras/<camera>/unsorted/`).
- ROI definitions (`cameras/<camera>/rois.json`).
- Exports (`cameras/<camera>/exports/…`).

### SQLite (`db.py` schema)
All authoritative user-editable state lives here as **current-value** tables
(no event log):

- `frames` — camera/filename/hash catalog (`UNIQUE(camera, hash)`).
- `labels`, `goldens` — one row per (camera, feature, frame).
- `deleted_frames` — camera-wide soft delete.
- `dedup_mute` — per-feature mute set.
- `settings` — per-camera key-value store (`reference_frame`, per-feature grid.*, dedup.*).
- `versions`, `version_items` — snapshots + items (FK cascade).

Derived caches (in the same DB):

- `score_cache` — per-frame feature vectors (hist, gray, backbone embeddings) keyed by (hash, feature, roi_key, kind).
- `results_cache` — scored `FrameScore` list JSON keyed by (camera, feature, roi_key), with `golden_sig` and `frames_sig` for stale detection.
- `cluster_snapshot` — per-frame `(cluster_id, is_rep)` payload.
- `scatter_cache` — 2D projection points per (camera, feature, method, backbone).

### Streamlit `st.session_state`

The keys form an informal per-view registry. Most are string patterns with identifiers embedded in them:

- `INGEST_REPORT_KEY = "ingest_report"` (single-shot report; defined in `ui_common.py`).
- Scored results: `classify::<camera>::<feature>` (defined in
  `view_classify/_helpers.scored_key`), plus companion `::gsig` and `::fsig`.
- Insights scored results: `insights::<camera>::<feature>` (defined only as a literal inside `view_insights.py`).
- Grid pagination: `page::<camera>::<feature>`.
- Grid per-page / cols: `perpage::<camera>::<feature>` and
  `cols::<camera>::<feature>` (each also has `::top` / `::bottom` variants used by the widgets, plus `::saved` markers to skip redundant DB writes).
- Dedup: `dedup::result::<camera>::<feature>`, `dedup::picks::…`,
  `dedup::method::…::g<N>` (widget), `dedup::gen::…` (generation counter for widget key rotation), `dedup::persisted::<camera>::<key>`, `dedup::clear-confirm::<camera>::<feature>`, `dedup::feature::<camera>::<product>`.
- Suggested-goldens: `suggest::n::…`, `suggest::promote::…`.
- Auto-assign: `auto::classes::…`, `auto::margin::…`, `auto::preview::…`, `auto::confirm::…`.
- ROI editor: `roimode::<camera>::<product>`; per-ROI product multiselect `prod::<full-name>`; delete confirm `confirm_del::<camera>::<feature>` (defined in `ui_common.confirm_delete_key`); products editor `products_edit`.
- Versions: `confirm_revert::<vid>`, plus button keys `rev::<vid>`,
  `exp::<vid>`, `yes::<vid>`, `no::<vid>`.
- Classify grid cell buttons: `lb::<feature>::<cls>::<frame>`,
  `gd::<feature>::<frame>`, `del::<camera>::<frame>`.
- Classify mute filter: `classify::show-muted::<camera>::<feature>`.

**Assessment**:
- The convention "prefix by view, then :: separated identifiers" is consistent enough to grep, but the keys are constructed ad-hoc — most live inline as f-strings inside view modules, not in a single registry.
- `ui_common.py` defines only a small subset of these (`INGEST_REPORT_KEY`, `ranked_key`, `clear_ranked`, `confirm_delete_key`); everything else is scattered.
- A rebranded or renamed feature would break silently because none of these keys have runtime validation.

### `contextvars`
Two independent, per-thread scoped caches:

- `datamodel._render_cache` — one-shot memoization for cameras/unsorted/rois/product-membership/product-frames/feature-frames within one view render. Invalidated by `invalidate_frames` (after ingest), `invalidate_rois` (after `save_rois`), and `invalidate_product_membership` (after every label/golden mutation).
- `perf._current_trace` — the active `PerformanceTrace` for the current request.

There is one more: `view_classify/_grid._FULL_GRID_RENDER` — a boolean `ContextVar` used to decide whether card renders should use the parent's bulk snapshots (full render) or targeted point queries (fragment rerun).

### Module-level singletons
- `embedding._torch`, `embedding._lock`, `embedding._import_failed` — lazy torch import protected by a lock.
- LRU caches: `embedding._load(backbone, device)` (`@lru_cache(maxsize=4)`); `ui_common._cached_cutout_thumb` (`maxsize=256`); `ui_common._cached_thumb_data_uri` (`maxsize=128`).

### Assessment — how centralised is state?
- **Persistent state is well-centralised.** `db.py` owns the schema and the CRUD calls; the higher-level modules never touch the connection directly except for a few places (`versions.freeze`, `versions.revert`, and inside `labels.set_label` etc. that use `db.connect()` explicitly to wrap an existing transaction).
- **Session state is scattered.** Keys are constructed inline, in
  f-strings, in many files. A future refactor that renames a feature or method would need to search for every string pattern. There is no session-state registry file even though `ui_common.py` declares a couple of key constants.
- **Render-scope cache is central but implicit.** Every domain read that wants memoization calls `_snapshot_value(("cameras", …), loader)` with a hand-rolled tuple key. Additions must remember to add invalidation on every write path. The current code does this correctly, but the wiring
  is manual.

---

## 3. Duplicated logic

- **`compose_feature(product, WHOLE_FRAME_FEATURE)` list assembly** —
  identical five-line snippet in `view_classify/render.py:92-94`,
  `view_dedup.py:88-90`, `view_insights.py:21-23`, `view_versions.py:27-29`. All four then feed the list into a `st.selectbox` with the same `format_func=lambda f: ui_common.feature_label(camera, f, product)`. This is the canonical extract-into-helper candidate.

- **Bulk-label "range slider" pattern** — `view_classify/_bulk.py:52-73` and `view_classify/_auto.py:59-68` both do:
  ```
  lo, hi = float(min(vals)), float(max(vals))
  if hi <= lo: hi = lo + 1e-6
  slider(..., step=max((hi - lo) / 100, 1e-6), format="%.4f")
  ```
  The identical guard against a degenerate range and the identical step formula appear three times if you count the "min confidence" slider in `_bulk`.

- **Frame-cutout thumbnail row** — `view_dedup.py:_cluster_row` and
  `view_dedup.py:_thumb_row` (`view_dedup.py:493-505`) share the same structure for building an `st.columns` row of `st.image` cells with the same `ui_common.cutout_thumb` call. Small enough to leave, worth noting.

- **`labels.counts` per-class breakdown loop** — reimplemented inline in `versions.freeze` (`versions.py:33-38`) with the same shape as `labels.counts` itself. Neither uses the other; the freezer produces the counts dict, then also calls `labels.counts` implicitly nowhere. Keep one source of truth.

- **`compose_feature`-plus-`whole-frame` feature picker** — see the first bullet. It also duplicates the caption for a shared ROI in `view_classify/render.py` and (partly) in `view_dedup.py` /
  `view_insights.py`.

- **Golden-frames set** — `{frame for frames in gold.values() for frame in frames}` appears in `labels.counts`, `view_insights.py`, `view_classify/_auto.py`, `view_classify/_suggest_goldens.py`, `versions.freeze`. Cheap enough that extracting a helper is a style choice, but there is no shared helper today.

- **`ScoringProgressUI` construction + refresh + error handling** — the pattern in `view_classify/render.py:_run_and_cache` and
  `view_insights.py:57-66` is the same in shape (create progress, call `classify.refresh`, on exception `progress.error(...)` + reraise, then advance to `presentation`). Not identical enough to be a straight extract.

- **Per-feature settings persistence with a "skip if same" marker** — `view_dedup._persist_setting` (marker keyed
  `dedup::persisted::<camera>::<key>`) and `view_classify/_grid._persist_if_changed` (marker keyed `<session_key>::saved`) implement the same pattern with different naming.

- **`_load_setting` / `_load_grid_setting`** — nearly identical: parse a saved SQLite string with a cast, fall back to a default. Two independent implementations in `view_dedup.py:118` and `view_classify/_grid.py:33`.

- **Camera-name sanitizer regex `[^A-Za-z0-9._-]+`** — used in
  `view_ingest.py:149` (create camera) and `ingest._SAFE` for file names. Same character class, different context.

- **`golden_frames = {…}` and "candidate filter" list comprehension** — the exact filter for "unlabeled non-golden with a leaning + margin under method M" appears in `_auto.render_auto`, `_suggest_goldens.render_suggest` and `_suggest_goldens.suggest`. Two of the three surface the "any
  candidate?" cheap probe as an inline `any(...)`; the third builds the full list.

None of these duplications is dangerous today. They are the kind of weight that accumulates in view code and slows down UI change.

---

## 4. Dead code / unused surface area

Grepped exhaustively across `scripts/`, `tests/`, and benchmarks.

### Never referenced anywhere (production or tests)

- **`ui_common.ranked_key(camera, feature, method)`** — declared at
  `ui_common.py:83`. Also declared partner `clear_ranked` (called only from `view_roi_editor/_roi_list.py:184` inside `_render_delete_confirm`). The `clear_ranked` prefix (`f"ranked::{camera}::{feature}::"`) matches no other key in the code today, so `clear_ranked` currently deletes nothing. Safe to remove both.

- **`curation.CutoutFeatures`, `curation.extract_features`,
  `curation.build_reference_features`, `curation.score_against_golden`,
  `curation.Score`** — the classical scoring "public API" from before the cache/batch refactor. Only used from tests (`test_current_state.py`) and benchmarks, not from the production classify pipeline. `classify.py` uses only `curation._hsv_histogram`, `curation._gray_standard`, `curation._hist_distance`, `curation._mse_distance`, `curation._ssim_distance`, and `curation.combine`. If we delete the dead ones, tests need to be updated (they're smoke-test only).

- **`curation.load_image`** — used only via `engine.curation.load_image`
  (three call sites: `versions.py:249`, `ui_common.py:316`,
  `view_roi_editor/_canvas.py:68`). Its own module never imports
  `engine.curation`; those callers rely on the fact that `engine.py` imports `curation` at module scope to keep the alias reachable. It's not dead code, but the routing is bizarre — see §7 below.

- **`ingest._TARGETS` and its `target` argument** — `_TARGETS` maps
  `"unsorted"` to `datamodel.unsorted_dir`. It has one entry.
  `ingest_files(camera, target, ...)` validates against this dict, but every call site passes `"unsorted"`. `view_ingest._INGEST_TARGET = ("unsorted", "frames")` is a two-item tuple hard-coded for the sole target. Historical
  artifact from a previous "reference frames as a separate folder" design.

- **`_source: str = "user"` parameter on `db.restore_frames` and
  `db.add_dedup_unmutes`** — both functions `del source` on entry. Dead parameter, preserved presumably for symmetry with the corresponding insert functions.

- **`_generation(camera, feature)` return value** — `view_dedup.py:109-115`; fine as-is; not dead, but the entire "widget key generation" pattern works around a Streamlit limitation and would be worth extracting into a helper in `ui_common.py`.

- **`config.WHOLE_FRAME_FEATURE`** — used in feature pickers to add a
  pseudo-feature name (`whole-frame`). Not dead, but relies on the convention that `datamodel.get_roi(camera, "whole-frame")` returns `None` and then `engine.resolve_roi` falls back to `ROI.full_frame`. Any actual user-defined ROI named `"whole-frame"` would silently shadow it.

- **`config.METRIC_WEIGHTS`** — used only by `curation.combine`; the
  `combine` call site in `classify._method_distance` never passes custom weights, so every "cpu" combination uses the equal-weights default. `docs/methodology.md` (referenced from `README.md`) already notes SSIM dominates in practice; the weights knob exists but is never adjusted from the UI.

- **`config.EMBEDDING_ENABLED`** — the only reader is `embedding.available()`. It is always `True` in `config.py`; there is no UI to toggle it. Not strictly dead, just latent.

### Imports that could be removed

- `view_classify/render.py:10` imports `dedup` but only uses it via `dedup.load_snapshot`; that's a real use, so the import is needed. However, `view_classify/render.py:12` imports `engine` and only uses `engine.resolve_roi` in one place (line 157); the import is needed but worth flagging that a lot of files reach for `engine.resolve_roi` + `classify._roi_cache_key` together (see next item).

- Repeated pair `engine.resolve_roi(camera, feature)` + `classify._roi_cache_key(roi)` in `view_classify/render.py:157`, `dedup.py:93-94`, `classify.refresh` itself, and `view_classify/_grid.py:99` (only the resolve half, for `roi_tuple = ui_common.roi_key(roi)`). This is a coherent unit that would fit in `engine.py` — right now `_roi_cache_key` is private to `classify.py`.

### Benchmarks / dev files

Ten `benchmark_*.py` scripts in `scripts/` are useful and self-contained, but they sit next to production code and complicate any "list all production modules" glance. Moving them under `scripts/benchmarks/` would be a pure organizational improvement.

---

## 5. Streamlit-specific performance issues

### Positive existing patterns
- `datamodel.render_snapshot()` is a solid pattern: one render sees a consistent set of frame lists and ROI lists, and mutation sites invalidate the right keys.
- Thumbnail LRU caches at `ui_common._cached_cutout_thumb` (256) and `_cached_thumb_data_uri` (128) prevent re-decode on every rerun.
- `@st.fragment` on `view_classify/_grid._card` means label/star clicks don't rerun the whole page — a big win on 24- and 48-card pages.
- `perf` spans are wrapped around the actual hot paths (`scoring.features`, `scoring.comparison`, `grid.presentation`, etc.), so any refactor can measure regressions.
- The persistent `results_cache` (SQLite) means a returning user sees the grid immediately without re-refreshing.

### Real performance/design smells

- **Every read is a new SQLite connection.** `db.connect()` is called at the top of nearly every function in `db.py`, `labels.py`, `versions.py`, and inside the `_grid._card_state` fragment-rerun branch (`labels.current_label_for_frame`, `labels.current_golden_for_frame`, `db.is_frame_deleted`). On a busy render this means 100+ open/close cycles. Each connection sets `journal_mode=WAL` and `foreign_keys=ON` (`db.py:176`) — WAL is a per-DB pragma so re-running it is a no-op, but the pragma statement executes every time. Both consequences are cheap on a local SQLite, but they reflect a design that never adopted a per-request connection pattern. A `contextvars`-scoped connection paired with `render_snapshot` would cut open/close overhead cleanly.

- **`labels.hash_map(camera)`** rebuilds the entire frame index if the in-memory result is empty AND the unsorted directory has files — that's fine, but every call to `set_label` / `set_labels_bulk` / `mark_golden` goes through `frame_hash` which either takes a passed `hmap` or calls `db.frame_hash_for(camera, filename)` (one query per call). No render-scope cache for hash maps. On a 500-frame refresh, this is invisible; on a 5000-frame first-time refresh with a slow disk it may be measurable.

- **`view_classify/_grid._card_state` on fragment reruns issues three targeted queries** per click (`current_label_for_frame`,
  `current_golden_for_frame`, `is_frame_deleted`), each opening its own connection. Rewriting to reuse one connection per card would collapse three connections into one; better still, one JOIN query.

- **The button loop inside `_buttons` writes and reruns.** That is the intended UX — an OK click is expected to persist and repaint the card. But note that `st.rerun(scope="app")` (used by the delete branch) rebuilds the entire outer render, which re-runs `labels.current_states_for_features`, `versions.summaries`, etc. Any perf issue with delete would come from that path, not the card itself.

- **`ui_common.thumb_data_uri` / `cutout_thumb` hits/misses tracked via LRU `cache_info` diff.** The counter is correct but the pattern is
  fragile — if we one day switch to `st.cache_data`, the introspection
  goes away. Not a bug, worth knowing.

- **`view_dedup._cluster_row` renders up to 24 `st.image` cells per
  cluster** with no fragmentation. For a camera with 50 clusters, the whole page renders every image on every rerun (slider changes, radio toggles). This is very likely why a big-camera Dedup session feels slow. The Classify grid solved this with `@st.fragment`; Dedup did not.

- **`view_dedup._cluster_action` recomputes `_drift_bits` on every rerun** and holds the entire `ClusterResult` in `st.session_state`, including the NxD embeddings matrix. For a camera with N=5000 frames and 2048-D ResNet50 embeddings, that is ~40 MB retained per session across reruns. Freeing on Apply is done, but casual scrolling holds it.

- **`view_versions.render`'s per-version expander calls
  `versions.list_versions` implicitly via the dataframe row loop AND then loops through the same `vl` for the Actions section.** Two passes, one DB call. Fine.

- **`view_versions.render` calls `versions.list_versions` once but each row loop over `vl` inside the dataframe also calls the versions loader logic — check.** `list_versions` returns the list; the loop just iterates it. OK.

- **`@st.cache_data` / `@st.cache_resource` are NOT used anywhere.** The Classify grid gets its speed from three orthogonal mechanisms (`render_snapshot`, `@st.fragment`, `functools.lru_cache`), not from Streamlit's decorators. That's a defensible choice — `st.cache_data`'s argument-hash step would need custom hashers for `ROI` and `FrameScore` objects — but there is no place today where a `@st.cache_data` annotation would be a bug fix. It could help in Versions (`list_versions`
  per-camera-feature) if measured to be a hotspot.

- **`streamlit_js_eval` in `ui_common.editor_display_width`** — called
  every ROI-editor render to read `window.innerWidth`. The library round-trips through a component; the cost is negligible per render but the returned viewport width isn't cached, so it's re-read on every rerun. Also see the known limitation in `docs/current-project.md`.

- **`class_bars_html` builds HTML strings on the Python side for every card**. Cheap per card, but for a 96-card page it's called 96 times and each string is 2–3 KB of markup. Streamlit's `st.markdown(..., unsafe_allow_html=True)` also disables its normal sanitiser check every time. Acceptable, not a fix candidate.

### Streamlit anti-patterns NOT observed
- No `time.sleep()` in render code.
- No auto-refresh (`st_autorefresh`) hooks.
- No accidental repeated calls to `st.file_uploader` outside the intended form.
- No use of `st.experimental_*` deprecated APIs (except perhaps `plotly_chart(use_container_width=True)`, which is scheduled for deprecation in favor of `width`).

---

## 6. Overly large files / functions doing too many things

### Files
- **`scripts/db.py` (555)** — one file for the schema + every CRUD operation across frames, labels, goldens, deletes, mutes, settings, three cache tables, and versions. It's still readable because each function is small and the schema is at the top, but it will grow.

- **`scripts/classify.py` (653)** — five distinct responsibilities:
  (1) result dataclasses (`MethodScore`, `FrameScore`,
  `ProgressUpdate`, `_PreparedVectorCache`),
  (2) score-cache batch load/write helpers,
  (3) per-frame feature preparation with progress,
  (4) per-method distance functions + batch scoring (`_score_cpu_batch`, `_score_neural_batch`, `_score_candidate_batch`),
  (5) the `refresh` orchestrator + JSON serialise/deserialise + stats. A split into `classify_cache.py`, `classify_distance.py`, `classify_pipeline.py` would make each unit a two-screen file.

- **`scripts/view_dedup.py` (557)** — one file, ten helpers, no submodule split. Approaching the size that motivated the Classify and ROI editor splits.

- **`scripts/ingest.py` (448)** — one function (`ingest_files`) is 187
  lines. Includes progress emission, empty-file detection, dup detection, temp-file staging, name sanitization, catalog upsert, per-batch commit, final commit. Could split into `_hash_and_stage_one`, `_commit_one`, `_finalize_index`.

- **`scripts/view_classify/_grid.py` (437)** — pagination + card + button row. The card + buttons together are ~200 lines and are the most frequently edited surface.

### Functions with too many jobs
- `ingest.ingest_files` (~187 lines).
- `classify.refresh` (~145 lines) — discovery + feature prep +
  golden vector build + candidate batching + result reconstruction.
- `view_dedup.render` (~55 lines, but calls into ~11 helpers that all share unstructured state through session-state strings).
- `view_classify/_grid._buttons` — three logically separate flows
  (class button, star, trash) stitched into one 100-line function.

---

## 7. Curiosities worth calling out

- **`engine.curation.load_image` indirection.** `engine.py` is a 15-line
  file with one function (`resolve_roi`). It also `import curation` at module scope. Three unrelated callers (`versions.py`, `ui_common.py`, `view_roi_editor/_canvas.py`) reach `curation.load_image` **through** `engine.curation.…`. That routing is not documented and there is no reason those callers can't `import curation` themselves. It smells like a shim from a refactor that never finished.

- **`config.EMBEDDING_BACKBONES` order matters** — `embedding.backbones()` filters by "known specs" but returns in `config` order, and `view_classify/_controls.py:29` uses that order to pick a default when `resnet50` isn't present (falls back to `methods[0]`, which today is always `"cpu"`). This is fine but a subtle coupling.

- **`labels.set_labels_bulk`** calls `clear_label` individually inside a loop when `cls == ""`. Each `clear_label` opens its own connection with its own transaction. Bulk-clear via `IN (...)` would be one query. Currently only triggered from `_bulk` when the user picks an empty class, which the UI doesn't offer, so this is dormant.

- **`versions.revert` is not one transaction.** Each per-frame `set_label` / `clear_label` / `mark_golden` opens its own connection. A crash mid-revert leaves partial state. `active=1` is flipped in a separate connection at the end. Documented in the behavior inventory.

- **The `docs/current-project.md` view list says five views**; the app has seven (`Status`, `Ingest`, `ROI editor`, `Dedup`, `Classify`,
  `Insights`, `Versions`). The docstring at the top of `app.py` also says five. The router dict `_VIEWS` and the sidebar radio have all seven. Doc drift, not a code bug.

- **Test coverage skews to the pipeline, not the views.** There are tests for `classify` batching, streaming, cache hydration, thumbnail cache, ingest streaming/progress — but no view-level tests. If we did a UI refactor, we'd be flying blind on visible behavior; that's what the accompanying `BEHAVIOR_INVENTORY.md` is meant to backstop.

- **Encoding**: `view_classify/_grid.py:106` contains `â€¦` (double-encoded ellipsis). It's the only mojibake I saw. This is a real user-visible bug in the "Preparing …" caption.

---

## 8. Overall assessment: messy but modular

**This is "messy but modular", not "structurally tangled".** Justification:

### The good — supports incremental refactor
1. **Layered ownership is clear**: `roi.py → datamodel.py → db.py →
   labels.py / versions.py → classify.py / dedup.py / scatter.py → view_*/`.
   Views never touch the SQLite connection directly. All mutations flow through the domain modules.
2. **The domain invariants are enforced in one place** (`labels.py`) with transactional writes and matching invalidation calls. A refactor of a view module cannot violate the golden = labeled invariant.
3. **The two views that grew past reading size (Classify at 1378 lines, ROI editor at 768) were already split into submodules** with focused responsibilities. The split is coherent (`_controls`, `_grid`, `_bulk`, `_auto`, `_suggest_goldens`, `_styles`, `_helpers`, `render`), not arbitrary. That's a good template for splitting `view_dedup.py` next.
4. **Persistent state has one owner** (`db.py`) with a versioned schema, a reset story, and a `DatabaseResetRequired` exception the app catches cleanly.
5. **The scoring pipeline is genuinely testable** — 14 tests, all
   pipeline-focused. The `perf` module means any regression can be measured with existing benchmarks.
6. **`datamodel.render_snapshot()` and `@st.fragment` show the project already thought about Streamlit rerun cost** where it hurt. The patterns are in place; they just haven't been applied everywhere yet (Dedup, Insights).

### The bad — but scoped to specific files, not the whole graph
1. **Session-state keys are scattered inline** as f-strings across 8+ files, with no registry and no runtime validation. A rename would silently break behavior. Fixable by introducing a `session_state.py` with typed helpers, incrementally per view.
2. **A handful of unused APIs** (`curation.CutoutFeatures` and friends, `ui_common.ranked_key` / `clear_ranked`, the `source` dead parameters, the single-target `_TARGETS`) are easy to prune once someone commits to a cleanup pass. None of them influence current behavior.
3. **Duplication is real but small** — the "compose_feature + whole-frame + feature_label" pattern in four view modules is the most tempting extract-into-helper opportunity, at ~5 lines * 4 sites.
4. **`view_dedup.py` is the next split candidate** — the same size and internal structure that motivated the Classify refactor.
5. **The `engine.curation.load_image` indirection** is a small mess in a small file. Ten-minute cleanup.
6. **`db.connect()` per call** is a design point, not a bug, but is the single biggest lever for a "make everything a bit faster" refactor if we ever needed to.
7. **The mojibake in `_grid.py:106`** is a real user-visible defect and fixing it is trivial.

### Not observed — signs of "structurally tangled"
- No circular imports between domain modules (the `import labels` inside `datamodel._product_membership` is lazy specifically to avoid one, and it's documented in a comment).
- No god objects. The largest classes are `PerformanceTrace` (dataclass) and `ROI` (dataclass) — both small.
- No hidden global mutable state beyond the two `contextvars`, the torch import cache, and the three `lru_cache`s.
- No `st.session_state` reads inside domain modules; that boundary is respected.
- No config values that live in more than one place.

### Recommendation
An incremental, file-by-file refactor is the right shape:

1. Prune the dead code list (§4) as a first commit. Zero-risk, ~200 lines removed, tests still green.
2. Fix the mojibake ellipsis and any similar encoding issues.
3. Extract the four-way duplicated feature-picker snippet into `ui_common.feature_picker(camera, product, key)` or similar.
4. Introduce a `view_classify/_state.py` (or extend `_helpers.py`) that owns every `f"classify::…"` and `f"insights::…"` key with typed accessors; migrate call sites over N commits.
5. Split `view_dedup.py` in the same shape as `view_classify/`.
6. Consolidate the `engine.curation` shim by giving those three callers a direct `curation.load_image` import.
7. Add per-request DB connection reuse via `contextvars` + a scoped `db.connection()` context manager, if profiling shows it matters.

A staged rebuild would throw away real assets — the domain invariants, the tested scoring pipeline, the reasoned Streamlit-rerun patterns, the performance-tracing scaffolding — for benefits that are already available by iterating on the current structure.
