"""Session-state key helpers and shared UI constants for the Dedup view.

The dedup submodules share a handful of ``st.session_state`` slots
scoped by (camera, feature). Centralising the key shapes here keeps the
producers and consumers from drifting the same way ``session_keys``
does for the cross-view slots.
"""
from __future__ import annotations

import streamlit as st


# --- shared user-facing copy -------------------------------------------------
MUTE_TOGGLE_HINT = "Show muted"


# --- session-state keys (dedup-internal, scoped by camera + feature) ---------
def result_key(camera: str, feature: str) -> str:
    """Cached :class:`dedup.ClusterResult` from the last click of *Cluster*."""
    return f"dedup::result::{camera}::{feature}"


def picks_key(camera: str, feature: str) -> str:
    """Per-cluster representative overrides ``{cluster_id: frame}``."""
    return f"dedup::picks::{camera}::{feature}"


def _generation_key(camera: str, feature: str) -> str:
    return f"dedup::gen::{camera}::{feature}"


def generation(camera: str, feature: str) -> int:
    """Bumped by Revert so slider widgets get fresh keys and re-init cleanly."""
    return int(st.session_state.get(_generation_key(camera, feature), 0))


def bump_generation(camera: str, feature: str) -> None:
    st.session_state[_generation_key(camera, feature)] = (
        generation(camera, feature) + 1
    )
