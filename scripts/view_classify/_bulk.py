"""Bulk-label expander — acts on **all** matching frames, not just the page.

Only scored candidates are ever selectable: goldens are references and never
score themselves, so ranking them by margin/novelty is meaningless.
"""
from __future__ import annotations

import streamlit as st

import classify
import labels


def render_bulk(
    items,
    *,
    camera: str,
    feature: str,
    classes: list[str],
    rank_method: str,
    scored: bool,
) -> None:
    """Three-mode picker (leaning / most-ordinary / most-uncertain) + label buttons."""
    selectable = [r for r in items if rank_method in r.per_method]
    if not (scored and selectable):
        return

    with st.expander(f"Bulk-label a selection ({len(selectable)} matching)", expanded=False):
        mode = st.radio(
            "Select",
            [
                "Frames leaning a class (confident ones)",
                "Most ordinary (lowest novelty)",
                "Most uncertain (smallest margin)",
            ],
        )
        picked: list[classify.FrameScore] = []

        if mode.startswith("Frames leaning"):
            lean_cls = st.selectbox("Leaning toward", classes)
            cand = [
                r for r in selectable
                if r.per_method[rank_method].leaning == lean_cls
                and r.per_method[rank_method].margin is not None
            ]
            if not cand:
                st.caption(
                    f"No frames lean **{lean_cls}** under `{rank_method}` — you need "
                    "goldens marked on *both* sides for leanings to exist."
                )
            else:
                margins = [r.per_method[rank_method].margin for r in cand]
                lo, hi = float(min(margins)), float(max(margins))
                if hi <= lo:
                    hi = lo + 1e-6
                minm = st.slider(
                    "Minimum confidence (margin between the two classes)",
                    lo, hi, lo, step=max((hi - lo) / 100, 1e-6), format="%.4f",
                )
                picked = [r for r in cand if r.per_method[rank_method].margin >= minm]
        else:
            use_margin = "uncertain" in mode
            vals = [
                (r.per_method[rank_method].margin if use_margin
                 else r.per_method[rank_method].novelty) or 0.0
                for r in selectable
            ]
            lo, hi = float(min(vals)), float(max(vals))
            if hi <= lo:
                hi = lo + 1e-6
            thr = st.slider("Select everything at or below", lo, hi, lo,
                            step=max((hi - lo) / 100, 1e-6), format="%.4f")
            picked = [r for r, v in zip(selectable, vals) if v <= thr]

        st.caption(
            f"**{len(picked)}** of {len(selectable)} matching frames selected — labelling "
            "applies to *all* of them, not just the page you're looking at."
        )
        b = st.columns(len(classes) + 1)
        for i, cls in enumerate(classes):
            if b[i].button(f"Label selection {cls}", disabled=not picked):
                n = labels.set_labels_bulk(
                    camera, feature, [r.frame for r in picked], cls
                )
                st.success(f"Labeled {n} frames as {cls}.")
                st.rerun()
