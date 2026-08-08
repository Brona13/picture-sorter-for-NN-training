"""Post-cluster overview: summary metric strip + optional 2D scatter plot.

The scatter silently omits itself if Plotly (or the chosen projector)
isn't installed — the rest of Dedup remains fully usable.
"""
from __future__ import annotations

import streamlit as st

import datamodel
import dedup
import labels
import scatter
import ui_common


def render_summary(result: dedup.ClusterResult) -> None:
    s = dedup.summary(result)
    would_mute = len(result.muted_from_representatives())
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Clusters", s["clusters"])
    c2.metric("Covered frames", s["covered"])
    c3.metric("Unique (noise)", s["unique"])
    c4.metric("Would mute", would_mute, help="Non-representative clustered frames.")


def render(
    camera: str, feature: str, result: dedup.ClusterResult,
) -> None:
    """2D scatter of the clustering, color-coded by cluster id (noise grey)."""
    try:
        import plotly.graph_objects as go  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return

    if result.embeddings.shape[0] < 2:
        return

    with st.expander("2D scatter (sanity check)", expanded=False):
        method_choice = st.radio(
            "Projection",
            options=list(scatter.SUPPORTED_METHODS),
            index=0,
            horizontal=True,
            key=f"dedup::scatter-method::{camera}::{feature}",
            help="UMAP tends to keep clusters compact; t-SNE spreads them more.",
        )

        try:
            proj = scatter.project(
                result.frame_order, result.embeddings,
                camera=camera, feature=feature,
                backbone=result.method, method=method_choice,
            )
        except ImportError:
            st.caption(
                "`umap-learn` (or scikit-learn for t-SNE) isn't installed — "
                "`pip install -r requirements-embedding.txt` enables the scatter."
            )
            return
        except Exception as e:  # noqa: BLE001
            st.warning(f"Projection failed: {e}")
            return

        fig = _figure(camera, feature, result, proj, go)
        st.plotly_chart(fig, use_container_width=True)
        st.caption(
            "*2D projection distorts distances — use for sanity check only.* "
            "Clustering decisions above stay in full-dimensional embedding space. "
            + ("(from cache)" if proj.from_cache else "(freshly projected)")
        )


def _figure(camera, feature, result, proj, go):
    """Assemble the Plotly figure: cluster points, representative rings, golden diamonds."""
    coords = proj.coords
    labels_map = result.labels_by_frame
    reps = set(result.representatives.values())
    gold = labels.current_goldens(camera, feature)
    gold_frames = {f: cls for cls, frames in gold.items() for f in frames}
    classes = datamodel.classes_for(camera, feature)

    fig = go.Figure()

    # 1. Noise / unique frames — grey, small.
    noise_x, noise_y, noise_txt = [], [], []
    for f in proj.frames:
        if labels_map.get(f, dedup.NOISE) == dedup.NOISE:
            x, y = coords[f]
            noise_x.append(x); noise_y.append(y); noise_txt.append(f)
    if noise_x:
        fig.add_trace(go.Scatter(
            x=noise_x, y=noise_y, mode="markers", name="unique",
            marker=dict(size=7, color="rgba(120,120,120,0.6)", line=dict(width=0)),
            text=noise_txt, hovertemplate="%{text}<br>(unique)<extra></extra>",
        ))

    # 2. One trace per real cluster so the legend groups them.
    for cid in result.clusters:
        color = ui_common.class_color(f"c{cid}", [f"c{i}" for i in result.clusters])
        xs, ys, txts = [], [], []
        for f in result.members(cid):
            x, y = coords[f]
            xs.append(x); ys.append(y); txts.append(f)
        fig.add_trace(go.Scatter(
            x=xs, y=ys, mode="markers", name=f"cluster {cid}",
            marker=dict(size=9, color=color, line=dict(width=0)),
            text=txts,
            hovertemplate=f"%{{text}}<br>cluster {cid}<extra></extra>",
        ))

    # 3. Representatives: ring overlay so they read as distinctive.
    if reps:
        rx, ry, rt = [], [], []
        for f in reps:
            if f in coords:
                x, y = coords[f]
                rx.append(x); ry.append(y); rt.append(f)
        fig.add_trace(go.Scatter(
            x=rx, y=ry, mode="markers", name="representative",
            marker=dict(size=15, color="rgba(0,0,0,0)", line=dict(width=2, color="#111")),
            text=rt, hovertemplate="%{text}<br>(representative)<extra></extra>",
        ))

    # 4. Goldens (if any yet): diamonds colored by class, drawn on top.
    if gold_frames:
        for cls in classes:
            gx, gy, gt = [], [], []
            for f, gcls in gold_frames.items():
                if gcls == cls and f in coords:
                    x, y = coords[f]
                    gx.append(x); gy.append(y); gt.append(f)
            if gx:
                fig.add_trace(go.Scatter(
                    x=gx, y=gy, mode="markers", name=f"⭐ {cls}",
                    marker=dict(
                        size=13, symbol="diamond",
                        color=ui_common.class_color(cls, classes),
                        line=dict(width=1.5, color="#fff"),
                    ),
                    text=gt,
                    hovertemplate=f"%{{text}}<br>golden — {cls}<extra></extra>",
                ))

    fig.update_layout(
        margin=dict(l=10, r=10, t=10, b=10),
        height=460,
        xaxis=dict(showgrid=False, zeroline=False, visible=False),
        yaxis=dict(showgrid=False, zeroline=False, visible=False),
        legend=dict(orientation="h", y=-0.05),
    )
    return fig
