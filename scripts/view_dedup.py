"""Dedup view — perceptual near-duplicate clustering with DBSCAN.

Runs independently of any golden set: pick camera + feature + backbone, adjust
epsilon / min_points, review the clusters, and mute the redundant members. The
representative frame of each cluster stays visible in Classify; the rest are
soft-hidden until the user clears the mutes for that feature.

Muting never touches source frames on disk and never mutes a labeled or golden
frame (see ``scripts/dedup.py``).
"""
from __future__ import annotations

import streamlit as st

import datamodel
import db
import dedup
import embedding
import engine
import labels
import scatter
import ui_common


_MUTE_TOGGLE_HINT = "Show muted"


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

    method, epsilon, min_points = _controls(camera, feature)
    result = _cluster_action(camera, feature, method, epsilon, min_points)
    if result is None:
        _existing_mutes_panel(camera, feature)
        return

    _render_summary(result)
    _render_scatter(camera, feature, result)
    if result.clusters:
        chosen = _render_clusters(camera, feature, result)
        _apply_panel(camera, feature, result, chosen)
    else:
        st.info(
            "No clusters at the current sliders. Everything looks unique under "
            "this embedding at this radius — try a larger *epsilon*, a smaller "
            "*min points*, or a different backbone."
        )
    _existing_mutes_panel(camera, feature)


# --- feature picker ----------------------------------------------------------
def _pick_feature(camera: str, product: str | None) -> str:
    return ui_common.feature_picker(
        camera, product, key=f"dedup::feature::{camera}::{product}"
    )


# --- controls ---------------------------------------------------------------
# Per-camera-feature settings keys — same shape as grid.cols.<f>/grid.perpage.<f>.
_SETTING_METHOD = "dedup.method.{feature}"
_SETTING_EPSILON = "dedup.epsilon.{feature}"
_SETTING_MINPOINTS = "dedup.min_points.{feature}"


def _generation(camera: str, feature: str) -> int:
    """Bumped by Revert so the slider widgets get fresh keys and re-init cleanly."""
    return int(st.session_state.get(f"dedup::gen::{camera}::{feature}", 0))


def _bump_generation(camera: str, feature: str) -> None:
    st.session_state[f"dedup::gen::{camera}::{feature}"] = _generation(camera, feature) + 1


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


def _controls(camera: str, feature: str) -> tuple[str, float, int]:
    backbones = embedding.backbones()
    saved_method = _load_setting(
        camera, _SETTING_METHOD.format(feature=feature), str, dedup.DEFAULT_BACKBONE
    )
    saved_epsilon = _load_setting(
        camera, _SETTING_EPSILON.format(feature=feature), float, 0.02
    )
    saved_min_points = _load_setting(
        camera, _SETTING_MINPOINTS.format(feature=feature), int, 2
    )

    if saved_method not in backbones:
        saved_method = dedup.DEFAULT_BACKBONE if dedup.DEFAULT_BACKBONE in backbones else backbones[0]

    # Widget keys carry a "generation" tag; Revert bumps the tag so the widgets
    # get fresh keys and re-initialise from `value=` / `index=`. Without this
    # trick Streamlit locks a widget's session_state entry once instantiated
    # and refuses programmatic assignment across reruns.
    gen = _generation(camera, feature)

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

    _persist_setting(camera, _SETTING_METHOD.format(feature=feature), method)
    _persist_setting(camera, _SETTING_EPSILON.format(feature=feature), round(epsilon, 6))
    _persist_setting(camera, _SETTING_MINPOINTS.format(feature=feature), int(min_points))

    return method, epsilon, min_points


# --- run cluster -------------------------------------------------------------
def _result_key(camera: str, feature: str) -> str:
    return f"dedup::result::{camera}::{feature}"


def _picks_key(camera: str, feature: str) -> str:
    return f"dedup::picks::{camera}::{feature}"


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


def _cluster_action(
    camera: str, feature: str, method: str, epsilon: float, min_points: int,
) -> dedup.ClusterResult | None:
    """Render the Cluster + Revert buttons; return the current cached result (if any)."""
    rk = _result_key(camera, feature)
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
        st.session_state.pop(_picks_key(camera, feature), None)
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
        db.set_setting(camera, _SETTING_METHOD.format(feature=feature), str(existing.method))
        db.set_setting(camera, _SETTING_EPSILON.format(feature=feature), str(round(float(existing.epsilon), 6)))
        db.set_setting(camera, _SETTING_MINPOINTS.format(feature=feature), str(int(existing.min_points)))
        # Clear our own "already persisted" markers so _persist_setting doesn't
        # skip the next legitimate write with a stale value.
        for base in ("method", "epsilon", "min_points"):
            key = f"dedup.{base}.{feature}"
            st.session_state.pop(f"dedup::persisted::{camera}::{key}", None)
        _bump_generation(camera, feature)
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


# --- summary + clusters ------------------------------------------------------
def _render_summary(result: dedup.ClusterResult) -> None:
    s = dedup.summary(result)
    would_mute = len(result.muted_from_representatives())
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Clusters", s["clusters"])
    c2.metric("Covered frames", s["covered"])
    c3.metric("Unique (noise)", s["unique"])
    c4.metric("Would mute", would_mute, help="Non-representative clustered frames.")


def _render_scatter(
    camera: str, feature: str, result: dedup.ClusterResult,
) -> None:
    """2D scatter of the clustering, color-coded by cluster id (noise grey).

    Silently omits itself if Plotly or the chosen projector isn't installed —
    the rest of Dedup remains fully usable.
    """
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

        fig = _scatter_figure(camera, feature, result, proj, go)
        st.plotly_chart(fig, use_container_width=True)
        st.caption(
            "*2D projection distorts distances — use for sanity check only.* "
            "Clustering decisions above stay in full-dimensional embedding space. "
            + ("(from cache)" if proj.from_cache else "(freshly projected)")
        )


def _scatter_figure(camera, feature, result, proj, go):
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


def _render_clusters(
    camera: str, feature: str, result: dedup.ClusterResult,
) -> dict[int, str]:
    roi = engine.resolve_roi(camera, feature)
    roi_tuple = ui_common.roi_key(roi)
    picks = st.session_state.setdefault(_picks_key(camera, feature), {})

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


# --- apply / clear -----------------------------------------------------------
def _apply_panel(
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
        st.session_state.pop(_result_key(camera, feature), None)
        st.session_state.pop(_picks_key(camera, feature), None)


def _existing_mutes_panel(camera: str, feature: str) -> None:
    muted = db.muted_frames(camera, feature)
    if not muted:
        return
    st.divider()
    st.subheader(f"Currently muted — {len(muted)} frame(s)")
    st.caption(
        "Muted frames stay on disk and can be revealed in **Classify** with "
        f"*{_MUTE_TOGGLE_HINT}*, or unmuted here in bulk."
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
