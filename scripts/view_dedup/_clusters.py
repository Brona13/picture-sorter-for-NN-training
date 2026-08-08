"""Per-cluster expanders + thumbnail rows.

Each expander shows a cluster's member thumbnails and a radio to pick
the representative. The chosen picks are stored under
``_helpers.picks_key`` so :mod:`_apply` can consume them.
"""
from __future__ import annotations

import streamlit as st

import datamodel
import dedup
import engine
import ui_common

from ._helpers import picks_key


def render(
    camera: str, feature: str, result: dedup.ClusterResult,
) -> dict[int, str]:
    roi = engine.resolve_roi(camera, feature)
    roi_tuple = ui_common.roi_key(roi)
    picks = st.session_state.setdefault(picks_key(camera, feature), {})

    st.subheader("Clusters")
    st.caption(
        "The chosen representative (radio) stays visible in Classify. Every "
        "other member of the cluster will be muted on Apply."
    )

    for cid in result.clusters:
        members = result.members(cid)
        default_rep = result.representatives[cid]
        current_rep = picks.get(cid, default_rep)

        with st.expander(
            f"Cluster {cid} — {len(members)} frames · rep: {current_rep}",
            expanded=(cid == result.clusters[0]),
        ):
            new_rep = _cluster_row(
                camera, feature, cid, members, current_rep, roi_tuple,
            )
            if new_rep != current_rep:
                picks[cid] = new_rep

    if result.noise_frames:
        with st.expander(
            f"Unique (noise) — {len(result.noise_frames)} frames (never muted)",
            expanded=False,
        ):
            _thumb_row(camera, result.noise_frames[:20], roi_tuple)
            if len(result.noise_frames) > 20:
                st.caption(f"…and {len(result.noise_frames) - 20} more.")
    return picks


def _cluster_row(
    camera: str, feature: str, cid: int, members: list[str], current_rep: str,
    roi_tuple,
) -> str:
    """One expander's contents: thumbnail strip + representative radio. Returns
    the (possibly newly-chosen) representative frame name."""
    max_show = 24
    shown = members[:max_show]
    cols = st.columns(min(6, len(shown)))
    for i, f in enumerate(shown):
        with cols[i % len(cols)]:
            path = datamodel.unsorted_dir(camera) / f
            try:
                st.image(
                    ui_common.cutout_thumb(str(path), roi_tuple, path.stat().st_mtime),
                    caption=("⭐ rep" if f == current_rep else f),
                )
            except Exception as e:  # noqa: BLE001
                st.error(f"thumb error: {e}")
    if len(members) > max_show:
        st.caption(f"…and {len(members) - max_show} more members not shown.")

    new_rep = st.radio(
        "Keep as representative",
        options=members,
        index=members.index(current_rep) if current_rep in members else 0,
        horizontal=True,
        key=f"dedup::rep::{camera}::{feature}::{cid}",
        label_visibility="collapsed",
    )
    return new_rep


def _thumb_row(camera: str, frames: list[str], roi_tuple) -> None:
    cols = st.columns(min(6, len(frames)))
    for i, f in enumerate(frames):
        with cols[i % len(cols)]:
            path = datamodel.unsorted_dir(camera) / f
            try:
                st.image(
                    ui_common.cutout_thumb(str(path), roi_tuple, path.stat().st_mtime),
                    caption=f,
                )
            except Exception as e:  # noqa: BLE001
                st.error(f"thumb error: {e}")
