"""Auto-assign unlabelled frames from the current method's leaning.

Different from ``_bulk`` in intent: bulk-label targets one class at a time
("label these OK"). Auto-assign fills in *every* unlabelled frame with
whatever its leaning suggests — the natural fit for stage-1 product sorting
once ResNet50 is trusted. Two-step (preview → confirm) so the user always
sees what will be written before it is written.
"""
from __future__ import annotations

import streamlit as st

import labels


def render_auto(
    items,
    *,
    camera: str,
    feature: str,
    classes: list[str],
    rank_method: str,
    scored: bool,
    lab: dict[str, str],
    gold: dict[str, list[str]],
) -> set[str] | None:
    """Render the auto-assign expander. Returns the set of frames the current
    slider + class picks would label — but only when the user has ticked
    *Show these in the grid*. ``None`` means no filter; caller shows every item.
    """
    if not scored:
        return None

    golden_frames = {f for frames in gold.values() for f in frames}
    candidates = [
        r for r in items
        if r.frame not in lab
        and r.frame not in golden_frames
        and rank_method in r.per_method
        and r.per_method[rank_method].leaning is not None
        and r.per_method[rank_method].margin is not None
    ]
    if not candidates:
        return None

    with st.expander(
        f"Auto-assign by leaning ({len(candidates)} unlabelled candidates)", expanded=False,
    ):
        st.caption(
            f"Fills in unlabelled frames using each frame's **{rank_method}** leaning. "
            "Nothing is written until you press **Confirm**."
        )
        chosen = st.multiselect(
            "Include only these classes",
            classes,
            default=classes,
            key=f"auto::classes::{camera}::{feature}",
        )
        margins = [r.per_method[rank_method].margin for r in candidates]
        lo, hi = float(min(margins)), float(max(margins))
        if hi <= lo:
            hi = lo + 1e-6
        minm = st.slider(
            "Minimum confidence (margin between top two classes)",
            lo, hi, lo,
            step=max((hi - lo) / 100, 1e-6), format="%.4f",
            key=f"auto::margin::{camera}::{feature}",
        )

        by_class: dict[str, list] = {c: [] for c in chosen}
        for r in candidates:
            ms = r.per_method[rank_method]
            if ms.leaning in by_class and ms.margin >= minm:
                by_class[ms.leaning].append(r)
        total = sum(len(v) for v in by_class.values())

        st.markdown(f"**Preview — {total} frame(s) will be labelled:**")
        for cls in chosen:
            picks = by_class[cls]
            if picks:
                avg = sum(r.per_method[rank_method].margin for r in picks) / len(picks)
                st.markdown(f"- `{cls}` — **{len(picks)}** frames · avg margin {avg:.4f}")
            else:
                st.markdown(f"- `{cls}` — —")

        preview_on = st.checkbox(
            f"Show these {total} in the grid below",
            value=False,
            disabled=total == 0,
            key=f"auto::preview::{camera}::{feature}",
            help=(
                "Filters the grid to the exact frames this panel would label. "
                "The grid still respects **Order by** — pair with *Most "
                "uncertain first* to spot-check the weakest picks."
            ),
        )

        if st.button(
            f"✅ Confirm auto-assignment of {total} frame(s)",
            type="primary",
            disabled=total == 0,
            key=f"auto::confirm::{camera}::{feature}",
        ):
            written = 0
            for cls, picks in by_class.items():
                if picks:
                    written += labels.set_labels_bulk(
                        camera, feature, [r.frame for r in picks], cls, source="auto",
                    )
            st.success(
                f"Auto-labelled {written} frame(s) using **{rank_method}**. "
                "Review or undo any of them from the grid."
            )
            st.rerun()

    if preview_on and total > 0:
        return {r.frame for picks in by_class.values() for r in picks}
    return None
