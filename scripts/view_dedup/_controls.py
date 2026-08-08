"""Sliders + backbone picker for the Dedup view, with per-feature persistence.

Widget keys carry a *generation* tag; the Revert path in ``_cluster``
bumps that tag so the widgets re-instantiate on the next run and pick
up the reverted values from ``value=``/``index=``. Without this trick
Streamlit locks a widget's ``session_state`` entry once instantiated
and refuses programmatic assignment across reruns.
"""
from __future__ import annotations

import streamlit as st

import db
import dedup
import embedding

from ._helpers import generation


# Per-camera-feature settings keys — same shape as grid.cols.<f>/grid.perpage.<f>.
SETTING_METHOD = "dedup.method.{feature}"
SETTING_EPSILON = "dedup.epsilon.{feature}"
SETTING_MINPOINTS = "dedup.min_points.{feature}"


def _load_setting(camera: str, key: str, cast, default):
    raw = db.get_setting(camera, key)
    if raw is None:
        return default
    try:
        return cast(raw)
    except (TypeError, ValueError):
        return default


def _persist_setting(camera: str, key: str, value) -> None:
    """Write only when the value actually changed — avoids redundant DB churn on reruns."""
    marker = f"dedup::persisted::{camera}::{key}"
    if st.session_state.get(marker) == value:
        return
    db.set_setting(camera, key, str(value))
    st.session_state[marker] = value


def render(camera: str, feature: str) -> tuple[str, float, int]:
    backbones = embedding.backbones()
    saved_method = _load_setting(
        camera, SETTING_METHOD.format(feature=feature), str, dedup.DEFAULT_BACKBONE
    )
    saved_epsilon = _load_setting(
        camera, SETTING_EPSILON.format(feature=feature), float, 0.02
    )
    saved_min_points = _load_setting(
        camera, SETTING_MINPOINTS.format(feature=feature), int, 2
    )

    if saved_method not in backbones:
        saved_method = dedup.DEFAULT_BACKBONE if dedup.DEFAULT_BACKBONE in backbones else backbones[0]

    gen = generation(camera, feature)

    c1, c2, c3 = st.columns([2, 3, 2])
    method = c1.selectbox(
        "Embedding",
        backbones,
        index=backbones.index(saved_method),
        help="Which ResNet backbone drives clustering. Smaller = faster; larger "
             "= richer features.",
        key=f"dedup::method::{camera}::{feature}::g{gen}",
    )
    epsilon = c2.slider(
        "Epsilon (neighborhood radius)",
        min_value=0.001, max_value=0.20,
        value=max(0.001, min(0.20, saved_epsilon)),
        step=0.001, format="%.3f",
        help="Cosine-distance radius around each point. Lower = tighter clusters. "
             "0.01–0.05 is a reasonable starting range for ResNet embeddings.",
        key=f"dedup::epsilon::{camera}::{feature}::g{gen}",
    )
    min_points = c3.slider(
        "Min points",
        min_value=2, max_value=10,
        value=max(2, min(10, saved_min_points)),
        step=1,
        help="Minimum cluster size. 2 is the loosest useful setting.",
        key=f"dedup::minpoints::{camera}::{feature}::g{gen}",
    )

    _persist_setting(camera, SETTING_METHOD.format(feature=feature), method)
    _persist_setting(camera, SETTING_EPSILON.format(feature=feature), round(epsilon, 6))
    _persist_setting(camera, SETTING_MINPOINTS.format(feature=feature), int(min_points))

    return method, epsilon, min_points
