"""Orchestrator: environment guards, feature picker, then delegate."""
from __future__ import annotations

import streamlit as st

import datamodel
import embedding
import ui_common

from . import _apply, _cluster, _clusters, _controls, _scatter


def render(camera: str, product: str | None = None) -> None:
    st.header(f"Dedup — {camera}" + (f" › {product}" if product else ""))

    if not embedding.backbones():
        st.warning(
            "Perceptual dedup requires ResNet embeddings. Install the neural "
            "dependencies (`pip install -r requirements-embedding.txt`), then "
            "return here."
        )
        return

    try:
        from sklearn.cluster import DBSCAN  # noqa: F401  (import probe)
    except Exception:  # noqa: BLE001
        st.warning(
            "scikit-learn isn't installed. Run "
            "`pip install -r requirements-embedding.txt` (it includes scikit-learn) "
            "and reload the app."
        )
        return

    feature = _pick_feature(camera, product)
    frames = datamodel.frames_for_feature(camera, feature)
    if not frames:
        st.info("This feature has no frames yet — ingest some first.")
        return

    st.caption(
        f"**{len(frames)} frame(s)** in scope. "
        "DBSCAN groups near-identical cutouts on their ResNet embeddings; the "
        "representative of each cluster stays visible in Classify, the rest are "
        "muted (never deleted)."
    )

    method, epsilon, min_points = _controls.render(camera, feature)
    result = _cluster.action(camera, feature, method, epsilon, min_points)
    if result is None:
        _apply.render_existing(camera, feature)
        return

    _scatter.render_summary(result)
    _scatter.render(camera, feature, result)
    if result.clusters:
        chosen = _clusters.render(camera, feature, result)
        _apply.render_apply(camera, feature, result, chosen)
    else:
        st.info(
            "No clusters at the current sliders. Everything looks unique under "
            "this embedding at this radius — try a larger *epsilon*, a smaller "
            "*min points*, or a different backbone."
        )
    _apply.render_existing(camera, feature)


def _pick_feature(camera: str, product: str | None) -> str:
    return ui_common.feature_picker(
        camera, product, key=f"dedup::feature::{camera}::{product}"
    )
