"""Suggested goldens — the "most uncertain, spread for diversity" picker.

Given the current scored list, surface a compact set of unlabeled frames
that would sharpen class separation the most: those with the smallest
margin between the two nearest classes, thinned so the picks aren't five
near-identical borderline frames.

Different from ``_auto`` in intent:

- ``_auto`` **bulk-labels the confident**: every frame past a margin floor
  gets its leaning as a label.
- This panel **hand-promotes the unconfident**: a handful of shaky
  candidates, one click per candidate, and each promotion becomes both a
  label AND a golden reference for that class.

See ``plans/curation-loop-enhancements.md`` (Phase 4) for the surrounding
design.
"""
from __future__ import annotations

import numpy as np
import streamlit as st

import classify
import datamodel
import dedup
import embedding
import engine
import labels
import ui_common


from suggest_goldens import (  # noqa: E402,F401 - moved to app/backend
    DEFAULT_N,
    N_MAX,
    N_MIN,
    POOL_K,
    _diversity_backbone,
    suggest,
)


# --- UI ---------------------------------------------------------------------
def render_suggest(
    items,
    *,
    camera: str,
    feature: str,
    classes: list[str],
    rank_method: str,
    scored: bool,
    lab: dict[str, str],
    gold: dict[str, list[str]],
) -> None:
    """Render the *Suggested goldens* expander. Silent if the panel has
    nothing useful to say (unscored, or no candidates)."""
    if not scored:
        return

    have_classes = [c for c in classes if gold.get(c)]
    if len(have_classes) < 2:
        return                              # leaning/margin need >=2 golden classes

    # Cheap probe: any candidate at all? (Re-uses the same filter suggest() uses.)
    golden_frames = {f for frames in gold.values() for f in frames}
    any_candidate = any(
        r.frame not in lab
        and r.frame not in golden_frames
        and rank_method in r.per_method
        and r.per_method[rank_method].leaning is not None
        and r.per_method[rank_method].margin is not None
        for r in items
    )
    if not any_candidate:
        return

    with st.expander("Suggested goldens (most-uncertain, spread for diversity)", expanded=False):
        st.caption(
            f"The frames the machine is least sure about under **{rank_method}**, "
            "spread across the ambiguity band by embedding-space diversity. "
            "One click labels *and* promotes to golden — sharpens class separation "
            "the fastest."
        )
        n = st.slider(
            "How many picks",
            min_value=N_MIN, max_value=N_MAX, value=DEFAULT_N, step=1,
            key=f"suggest::n::{camera}::{feature}",
        )
        picks = suggest(
            camera=camera, feature=feature, items=items,
            rank_method=rank_method, n=n, lab=lab, gold=gold,
        )
        if not picks:
            st.caption("No unlabeled candidates match — refresh scores or add more goldens.")
            return

        backbone = _diversity_backbone()
        st.caption(
            f"Showing **{len(picks)}** pick(s). "
            + (f"Diversity via `{backbone}`. " if backbone else "No ResNet available — top-by-margin only. ")
            + "See where they land on the **Dedup** view's 2D scatter."
        )
        _render_grid(picks, camera=camera, feature=feature, classes=classes, rank_method=rank_method)


def _render_grid(picks, *, camera, feature, classes, rank_method) -> None:
    roi = engine.resolve_roi(camera, feature)
    roi_tuple = ui_common.roi_key(roi)
    cols_per_row = 3

    for row_start in range(0, len(picks), cols_per_row):
        row_picks = picks[row_start:row_start + cols_per_row]
        cols = st.columns(cols_per_row)
        for col, fs in zip(cols, row_picks, strict=False):
            with col:
                _card(fs, camera=camera, feature=feature, classes=classes,
                      rank_method=rank_method, roi_tuple=roi_tuple)


def _card(fs, *, camera, feature, classes, rank_method, roi_tuple) -> None:
    path = datamodel.unsorted_dir(camera) / fs.frame
    try:
        st.image(ui_common.cutout_thumb(str(path), roi_tuple, path.stat().st_mtime))
    except Exception as e:  # noqa: BLE001
        st.error(f"thumb error: {e}")
        return

    ms = fs.per_method.get(rank_method)
    if ms is not None:
        st.markdown(
            ui_common.class_bars_html(ms.dists, classes),
            unsafe_allow_html=True,
        )
    st.caption(f"`{fs.frame}`")

    # One quick-label button per class. Clicking writes both a label and a
    # golden mark in one action. Source tag distinguishes these from manual
    # picks and from _auto's bulk fills.
    btn_cols = st.columns(len(classes))
    for bc, cls in zip(btn_cols, classes, strict=True):
        if bc.button(
            f"⭐ {cls}",
            key=f"suggest::promote::{camera}::{feature}::{fs.frame}::{cls}",
            use_container_width=True,
        ):
            labels.set_label(camera, feature, fs.frame, cls, source="suggest")
            labels.mark_golden(camera, feature, fs.frame, cls)
            st.toast(f"Promoted `{fs.frame}` → ⭐ {cls}")
            st.rerun()
