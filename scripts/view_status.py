"""Status view — per-feature counts and a clear ROI-defined indicator."""
from __future__ import annotations

import streamlit as st

import config
import datamodel
import labels
import versions


def render(camera: str, product: str | None = None) -> None:
    st.header(f"Status — {camera}")
    unsorted = datamodel.list_unsorted(camera)
    rois = datamodel.load_rois(camera)
    prods = datamodel.products(camera)
    c1, c2, c3 = st.columns(3)
    c1.metric("Frames", len(unsorted))
    c2.metric("Features (ROIs)", len(rois))
    c3.metric("Products", len(prods) if prods else "—")

    st.subheader("Features (ROIs)")
    if not rois:
        st.info("No ROIs defined yet — use the **ROI editor** to add some.")
        return

    feature_names = [roi.name for roi in rois]
    label_states, golden_states = labels.current_states_for_features(
        camera, feature_names
    )
    version_summaries = versions.summaries(camera, feature_names)

    # One row per ROI across the whole camera (every product), so this stays the
    # single place to see where the work stands. Class vocabularies differ per
    # feature, so counts are a compact per-class breakdown rather than columns.
    rows = []
    for r in rois:
        owner, short = datamodel.split_feature(r.name)
        classes = list(r.classes) if r.classes else list(config.CLASSES)
        c = labels.counts(
            camera,
            r.name,
            label_state=label_states[r.name],
            golden_state=golden_states[r.name],
        )
        version_summary = version_summaries[r.name]
        if r.role == "classify":
            scope = "(defines products)"
        elif owner:
            scope = owner
        elif r.products:
            scope = "🔗 " + ", ".join(r.products)
        else:
            scope = "— all"
        rows.append(
            {
                "product": scope,
                "feature": short,
                "role": r.role,
                "labeled": " · ".join(f"{cls}: {c.get(cls, 0)}" for cls in classes) or "—",
                "⭐ goldens": " · ".join(
                    f"{cls}: {c.get(f'golden_{cls}', 0)}" for cls in classes
                ) or "—",
                "unlabeled": c.get("unlabeled", 0),
                "of": c.get("total", 0),
                "versions": version_summary["count"],
                "active": (
                    f"v{version_summary['active_number']}"
                    if version_summary["active_number"] is not None
                    else "—"
                ),
            }
        )
    st.dataframe(rows, width="stretch", hide_index=True)
