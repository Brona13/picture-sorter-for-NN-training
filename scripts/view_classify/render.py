"""Orchestrator: header, feature picker, metrics, refresh, then delegate."""
from __future__ import annotations

import streamlit as st

import classify
import config
import datamodel
import db
import dedup
import embedding
import engine
import labels
import perf
import ui_common

from . import _auto, _bulk, _controls, _grid, _helpers, _suggest_goldens
from ._styles import OK_TINT_JS


def render(camera: str, product: str | None = None) -> None:
    st.header(f"Classify — {camera}" + (f" › {product}" if product else ""))
    # Static trusted code: mark just the active OK buttons for green styling.
    st.html(OK_TINT_JS, unsafe_allow_javascript=True)

    feature = _pick_feature(camera, product)

    with perf.span("classify.current_state"):
        classes = datamodel.classes_for(camera, feature)
        gold = labels.current_goldens(camera, feature)
        lab = labels.current_labels(camera, feature)
        counts = labels.counts(
            camera, feature, label_state=lab, golden_state=gold,
        )
        methods = classify.methods_available()

    _metrics(counts, classes)
    _start_here(gold, classes)

    results, refresh_progress = _refresh(camera, feature, gold, methods)
    if not results:
        if refresh_progress is not None:
            refresh_progress.complete("No frames to display")
        return

    scored = any(r.per_method for r in results)
    _stale_warning(camera, feature, gold)

    results = _apply_mute_filter(camera, feature, results)

    view, rank_method, order = _controls.render_controls(
        classes=classes, methods=methods, scored=scored, gold=gold,
    )
    deleted = db.deleted_frames_of(camera)
    with perf.span("classify.filter_and_sort"):
        items = _controls.filter_and_sort(
            results, view=view, rank_method=rank_method, order=order,
            scored=scored, methods=methods, lab=lab, gold=gold, deleted=deleted,
        )
    _bulk.render_bulk(
        items, camera=camera, feature=feature, classes=classes,
        rank_method=rank_method, scored=scored,
    )
    auto_preview = _auto.render_auto(
        items, camera=camera, feature=feature, classes=classes,
        rank_method=rank_method, scored=scored, lab=lab, gold=gold,
    )
    _suggest_goldens.render_suggest(
        items, camera=camera, feature=feature, classes=classes,
        rank_method=rank_method, scored=scored, lab=lab, gold=gold,
    )
    if auto_preview is not None:
        items = [r for r in items if r.frame in auto_preview]
        st.caption(
            f"🔍 Grid filtered to the **{len(items)}** auto-assign preview frames "
            "(Show / class filters ignored while this is on)."
        )
    cluster_snapshot = dedup.load_snapshot(camera, feature)
    perf.count("grid.items_after_filter", len(items))
    with perf.span("classify.grid_render"):
        _grid.render_grid(
            items, camera=camera, feature=feature, classes=classes,
            methods=methods, rank_method=rank_method, scored=scored,
            gold=gold, lab=lab, deleted=deleted,
            cluster_snapshot=cluster_snapshot,
        )
    if refresh_progress is not None:
        refresh_progress.complete()


def _pick_feature(camera: str, product: str | None) -> str:
    features = datamodel.list_features_for(camera, product) + [
        datamodel.compose_feature(product, config.WHOLE_FRAME_FEATURE)
    ]
    feature = st.selectbox(
        "Feature (ROI)", features,
        format_func=lambda f: ui_common.feature_label(camera, f, product),
    )
    shared_products = datamodel.feature_products(camera, feature)
    if shared_products:
        inbox = len(datamodel.list_unsorted(camera))
        seen = len(datamodel.frames_for_feature(camera, feature))
        gap = (
            f" It covers **{seen} of {inbox}** frames — the other {inbox - seen} have no "
            "product yet, so sort them under *All frames — product sort* first."
            if seen != inbox
            else ""
        )
        st.caption(
            f"🔗 **Shared ROI** — one golden set and one label set covering "
            f"**{', '.join(shared_products)}**. The grid shows every frame of those products, "
            f"whichever one the sidebar is on.{gap}"
        )
    if product and not datamodel.frames_for_feature(camera, feature):
        st.info(
            f"No frames are classified as **{product}** yet. Switch the sidebar to "
            "**▣ All frames — product sort**, label some frames with this product, then come back."
        )
    return feature


def _metrics(counts: dict, classes: list[str]) -> None:
    cols = st.columns(1 + len(classes))
    cols[0].metric("Frames", counts.get("total", 0))
    for i, cls in enumerate(classes, start=1):
        cols[i].metric(
            cls,
            counts.get(cls, 0),
            delta=f"⭐ {counts.get(f'golden_{cls}', 0)}",
            delta_color="off",
        )


def _start_here(gold: dict[str, list[str]], classes: list[str]) -> None:
    """Cold-start prompt shown when no class has any goldens yet."""
    if not any(gold.get(c) for c in classes):
        first_two = " / ".join(f"⭐{c}" for c in classes[:2])
        st.info(
            f"**Start here:** mark a few reference frames ({first_two}, …). Then hit Refresh — "
            "every frame gets scored against your goldens and shows which class it leans toward."
        )


def _refresh(
    camera: str, feature: str, gold: dict[str, list[str]], methods: list[str]
):
    """Return ``(current scored list, active refresh progress UI or None)``.

    Populate the scored list from persistent cache or an explicit refresh.

    Also renders the Refresh button + methods caption. Falsy return (``None``)
    means the caller should early-return: either no frames at all, or no
    goldens yet (cold start).
    """
    key = _helpers.scored_key(camera, feature)
    classes = datamodel.classes_for(camera, feature)
    roi_key = classify._roi_cache_key(engine.resolve_roi(camera, feature))

    # 1. Hydrate from the persistent cache the first time this feature is
    #    seen in the session. Whatever's there wins — even if stale — so the
    #    grid renders on entry; _stale_warning handles the "goldens moved on"
    #    signalling on top.
    if key not in st.session_state:
        with perf.span("results_cache.load"):
            row = db.load_results(camera, feature, roi_key)
        if row is not None:
            try:
                st.session_state[key] = classify.deserialise_results(row["payload"])
                st.session_state[key + "::gsig"] = row["golden_sig"]
                st.session_state[key + "::fsig"] = row["frames_sig"]
            except Exception:
                # A malformed row shouldn't wedge the view — fall through to
                # normal flow (either auto-compute or the cold-start hint).
                pass

    # 2. Refresh button — also writes the result to the persistent cache so
    #    it survives session state loss.
    c1, c2 = st.columns([1, 3])
    if c1.button("🔄 Refresh scores", type="primary"):
        refresh_progress = _run_and_cache(camera, feature, roi_key, gold, key)
    else:
        refresh_progress = None
    c2.caption(
        f"Methods: {', '.join(methods)} · neural device: {embedding.active_device()} · "
        "cached — only the first pass over a new batch is slow."
    )

    # 3. No auto-compute on a fresh ROI — the first scoring of any ROI is an
    #    explicit user action. Only cached ROIs render automatically (step 1).
    results = st.session_state.get(key)
    if results is None:
        st.caption("Click **Refresh scores** to evaluate the inbox.")
        return None, refresh_progress
    if not results:
        st.warning("No frames in this camera's `unsorted/` folder yet — add some in **Ingest**.")
        return None, refresh_progress
    return results, refresh_progress


def _run_and_cache(camera: str, feature: str, roi_key: str, gold, key: str):
    """Score + write to both session state and the persistent results cache."""
    progress = ui_common.ScoringProgressUI()
    try:
        with perf.span("refresh.score"):
            res = classify.refresh(
                camera, feature, phase_progress_cb=progress,
            )
    except Exception:
        progress.error()
        raise
    progress.update("persistence", 0, 1)
    gsig = _helpers.golden_signature(gold)
    fsig = _helpers.frames_signature(camera, feature)
    st.session_state[key] = res
    st.session_state[key + "::gsig"] = gsig
    st.session_state[key + "::fsig"] = fsig
    try:
        payload = classify.serialise_results(res)
        with perf.span("results_cache.save"):
            db.save_results(camera, feature, roi_key, gsig, fsig, payload)
    except Exception:
        # Never let a cache-write blow up the whole view — the compute
        # already succeeded and session state holds it.
        progress.warning("Scores ready, but persistent cache save failed")
    progress.update("persistence", 1, 1)
    progress.update("presentation", 0, 1, detail="grid")
    return progress


def _apply_mute_filter(camera: str, feature: str, results):
    """Hide dedup-muted frames by default; a toggle brings them back.

    Muted frames stay scored (their vectors are cached) — this is purely a
    review-time visibility filter, so toggling never triggers a re-refresh.
    """
    muted = db.muted_frames(camera, feature)
    if not muted:
        return results
    show_muted = st.checkbox(
        f"Show muted ({len(muted)} hidden by dedup)",
        value=False,
        key=f"classify::show-muted::{camera}::{feature}",
        help="Frames muted from the Dedup view are hidden here by default.",
    )
    if show_muted:
        return results
    return [r for r in results if r.frame not in muted]


def _stale_warning(camera: str, feature: str, gold: dict[str, list[str]]) -> None:
    key = _helpers.scored_key(camera, feature)
    gsig_stale = st.session_state.get(key + "::gsig") != _helpers.golden_signature(gold)
    fsig_stale = st.session_state.get(key + "::fsig") != _helpers.frames_signature(camera, feature)
    if gsig_stale:
        st.warning(
            "⭐ Goldens changed since the last refresh — mark as many as you like, then hit "
            "**Refresh scores** to re-evaluate everything against them."
        )
    elif fsig_stale:
        st.warning(
            "🆕 The frame set changed since the last refresh (ingest or delete) — hit "
            "**Refresh scores** to score the new set."
        )
