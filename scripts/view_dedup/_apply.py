"""Apply the current picks (mute non-representatives) and clear existing mutes.

The Apply button writes through :func:`dedup.apply`. The
Currently-muted panel is guarded by a confirm click so a stray tap
can't wipe the feature's mutes.
"""
from __future__ import annotations

import streamlit as st

import db
import dedup

from ._helpers import MUTE_TOGGLE_HINT, picks_key, result_key


def render_apply(
    camera: str, feature: str, result: dedup.ClusterResult,
    chosen: dict[int, str],
) -> None:
    would_mute = len(result.muted_from_representatives(chosen))
    disabled = would_mute == 0
    if st.button(
        f"🔇 Apply — mute {would_mute} frame(s)",
        type="primary", disabled=disabled,
    ):
        report = dedup.apply(camera, feature, result, chosen)
        skipped_bits = []
        if report.skipped_labeled:
            skipped_bits.append(f"{report.skipped_labeled} labeled")
        if report.skipped_golden:
            skipped_bits.append(f"{report.skipped_golden} golden")
        tail = f" · skipped: {', '.join(skipped_bits)}" if skipped_bits else ""
        unmute_bit = (
            f" · unmuted {report.unmuted} that no longer belong to a cluster"
            if report.unmuted
            else ""
        )
        st.success(f"Muted {report.muted} frame(s){unmute_bit}{tail}.")
        st.session_state.pop(result_key(camera, feature), None)
        st.session_state.pop(picks_key(camera, feature), None)


def render_existing(camera: str, feature: str) -> None:
    muted = db.muted_frames(camera, feature)
    if not muted:
        return
    st.divider()
    st.subheader(f"Currently muted — {len(muted)} frame(s)")
    st.caption(
        "Muted frames stay on disk and can be revealed in **Classify** with "
        f"*{MUTE_TOGGLE_HINT}*, or unmuted here in bulk."
    )
    # Guard rail: a second click confirms so the user can't wipe mutes by accident.
    confirm_key = f"dedup::clear-confirm::{camera}::{feature}"
    if st.session_state.get(confirm_key):
        c1, c2 = st.columns([1, 3])
        if c1.button("Yes — unmute all", type="primary"):
            n = db.clear_dedup_mutes(camera, feature)
            st.session_state[confirm_key] = False
            st.success(f"Unmuted {n} frame(s).")
        if c2.button("Cancel"):
            st.session_state[confirm_key] = False
    else:
        if st.button("♻️ Unmute all for this feature"):
            st.session_state[confirm_key] = True
