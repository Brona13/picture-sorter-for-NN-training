"""The Cluster / Revert action row, plus the cached-result state machine.

Clicking *Cluster* recomputes the DBSCAN result and stashes it under
``_helpers.result_key``. Clicking *Revert sliders* writes the previous
run's parameters back to the settings table and bumps the widget
generation so the sliders re-init on the next run.
"""
from __future__ import annotations

import streamlit as st

import db
import dedup
import embedding

from . import _controls
from ._helpers import bump_generation, picks_key, result_key


def _drift_bits(existing, method, epsilon, min_points) -> list[str]:
    """Human-readable per-slider drift descriptions vs a cached ClusterResult."""
    bits: list[str] = []
    if existing.method != method:
        bits.append(f"embedding {existing.method!r} → {method!r}")
    if abs(existing.epsilon - epsilon) > 1e-9:
        bits.append(f"ε {existing.epsilon:.3f} → {epsilon:.3f}")
    if existing.min_points != min_points:
        bits.append(f"minPts {existing.min_points} → {min_points}")
    return bits


def action(
    camera: str, feature: str, method: str, epsilon: float, min_points: int,
) -> dedup.ClusterResult | None:
    """Render the Cluster + Revert buttons; return the current cached result (if any)."""
    rk = result_key(camera, feature)
    existing = st.session_state.get(rk)
    drift = _drift_bits(existing, method, epsilon, min_points) if existing else []

    c_cluster, c_revert, c_caption = st.columns([1, 1, 3])

    if c_cluster.button("🔍 Cluster", type="primary"):
        bar = st.progress(0.0, text="Embedding frames…")
        try:
            result = dedup.cluster(
                camera, feature,
                epsilon=epsilon, min_points=min_points, method=method,
                progress_cb=lambda d, t: bar.progress(d / t if t else 1.0,
                                                      text=f"Embedding {d}/{t}"),
            )
        finally:
            bar.empty()
        st.session_state[rk] = result
        st.session_state.pop(picks_key(camera, feature), None)
        return result

    revert_help = (
        "Restore sliders to the values used by the last computed clustering."
        if existing
        else "Nothing to revert to — run a cluster first."
    )
    if c_revert.button(
        "↺ Revert sliders", disabled=not drift, help=revert_help,
    ):
        # Push reverted values to DB, then bump the widget generation so the
        # sliders re-render as fresh keys and pick up the new value/index on
        # the next run. Avoids Streamlit's "can't modify widget session_state"
        # error we hit trying to write to the current widget keys directly.
        db.set_setting(
            camera,
            _controls.SETTING_METHOD.format(feature=feature),
            str(existing.method),
        )
        db.set_setting(
            camera,
            _controls.SETTING_EPSILON.format(feature=feature),
            str(round(float(existing.epsilon), 6)),
        )
        db.set_setting(
            camera,
            _controls.SETTING_MINPOINTS.format(feature=feature),
            str(int(existing.min_points)),
        )
        # Clear our own "already persisted" markers so _persist_setting doesn't
        # skip the next legitimate write with a stale value.
        for base in ("method", "epsilon", "min_points"):
            key = f"dedup.{base}.{feature}"
            st.session_state.pop(f"dedup::persisted::{camera}::{key}", None)
        bump_generation(camera, feature)
        st.rerun()

    c_caption.caption(
        f"Neural device: {embedding.active_device()} · "
        "vectors are cached — first pass over a new batch is the slow one."
    )

    if existing is None:
        return None
    if drift:
        st.warning(
            "⚠ **Sliders changed since the last cluster** — clusters below "
            "still show the previous run (" + ", ".join(drift) + "). "
            "Click **🔍 Cluster** to recompute, or **↺ Revert sliders** to "
            "match what's shown."
        )
    return existing
