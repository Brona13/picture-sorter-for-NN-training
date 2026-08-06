"""Streamlit UI entry point for smart training-data curation.

Run from the project root::

    streamlit run scripts/app.py

The sidebar picks a camera, a **product scope**, and one of five views, each of which
lives in its own ``view_*.py`` module (shared helpers/constants are in ``ui_common.py``):

  * Status     — per-feature counts and a clear ROI-defined indicator.
  * Ingest     — upload / import images with content-based de-duplication.
  * ROI editor — drag-draw rectangles on any ingested frame; save as named features.
  * Classify   — mark per-class goldens, refresh scores, triage and label.
  * Versions   — freeze / revert / export dataset snapshots.

The **Product** selector only appears once a camera has a ``role="classify"`` ROI
defining product names; cameras without one behave exactly as before (a single
flat list of features), so existing setups are untouched.
"""
from __future__ import annotations

import streamlit as st

# set_page_config must be the first Streamlit command, so call it before importing
# the view modules (some pull in Streamlit components at import time).
st.set_page_config(page_title="Picture Sorter for NN Training", layout="wide")

import config  # noqa: E402
import datamodel  # noqa: E402
import db  # noqa: E402
import perf  # noqa: E402
import view_classify  # noqa: E402
import view_dedup  # noqa: E402
import view_ingest  # noqa: E402
import view_insights  # noqa: E402
import view_roi_editor  # noqa: E402
import view_status  # noqa: E402
import view_versions  # noqa: E402

# --- sidebar -----------------------------------------------------------------
st.sidebar.title("🖼️ Picture Sorter")
cameras = datamodel.list_cameras()
if not cameras:
    st.warning(
        f"No cameras found under `{config.CAMERAS_ROOT}`. Create a camera folder "
        "with an `unsorted/` subfolder, then restart the app. For example: "
        f"`{config.CAMERAS_ROOT / '<camera>' / 'unsorted'}`"
    )
    st.stop()

camera = st.sidebar.selectbox("Camera", cameras)

_VIEWS = {
    "Status": view_status.render,
    "Ingest": view_ingest.render,
    "ROI editor": view_roi_editor.render,
    "Dedup": view_dedup.render,
    "Classify": view_classify.render,
    "Insights": view_insights.render,
    "Versions": view_versions.render,
}


def _render_camera(camera: str) -> None:
    # Product scope: only offered once a classification ROI defines the products.
    all_frames = "▣ All frames — product sort"
    product: str | None = None
    product_names = datamodel.products(camera)
    if product_names:
        scope = st.sidebar.selectbox("Product", [all_frames, *product_names])
        product = None if scope == all_frames else scope
        st.sidebar.caption(
            "Stage 1 — sort every frame into a product."
            if product is None
            else f"Stage 2 — quality (OK/NG) within **{product}**."
        )

    view = st.sidebar.radio(
        "View",
        ["Status", "Ingest", "ROI editor", "Dedup", "Classify", "Insights", "Versions"],
    )
    st.sidebar.caption(f"Cameras root:\n`{config.CAMERAS_ROOT}`")

    with perf.trace(
        "streamlit.view_render", camera=camera, product=product, view=view
    ) as trace:
        _VIEWS[view](camera, product)

    if trace.enabled:
        with st.sidebar.expander("Performance diagnostics"):
            st.caption(
                f"Last {view} render: **{trace.elapsed_seconds * 1000:.1f} ms** · "
                "enabled by `CURATION_PERF_DIAGNOSTICS`."
            )
            rows = trace.table_rows()
            if rows:
                st.dataframe(rows, hide_index=True, width="stretch")
            if trace.counters:
                st.json(dict(sorted(trace.counters.items())), expanded=False)


# One snapshot spans sidebar scope resolution and the selected view. Mutating
# operations invalidate their affected entries before Streamlit reruns.
try:
    with datamodel.render_snapshot():
        _render_camera(camera)
except db.DatabaseResetRequired as error:
    st.error(str(error))
    st.code("python scripts/reset_database.py --yes")
    st.stop()
