"""Versions view — freeze / inspect / revert / export dataset snapshots.

A version is a recipe (labels + golden marks + hashes + stats), not image copies.
One version per camera+feature is *active*; reverting restores the working state
from a snapshot and moves the active marker.
"""
from __future__ import annotations

import time

import streamlit as st

import classify
import datamodel
import labels
import ui_common
import versions as versions_mod


def _fmt(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))


def render(camera: str, product: str | None = None) -> None:
    st.header(f"Versions — {camera}" + (f" › {product}" if product else ""))
    feature = ui_common.feature_picker(camera, product)
    classes = datamodel.classes_for(camera, feature)

    counts = labels.counts(camera, feature)
    st.caption(
        "Current working state — "
        + " · ".join(
            f"{c}: **{counts.get(c, 0)}**  ⭐{counts.get(f'golden_{c}', 0)}"
            for c in classes
        )
        + f" · unlabeled: {counts.get('unlabeled', 0)} of {counts.get('total', 0)}"
    )

    with st.form("freeze_version", clear_on_submit=True):
        st.markdown("**Freeze the current state as a new version**")
        name = st.text_input("Version name", placeholder="e.g. first-clean-batch")
        notes = st.text_area("Notes (optional)", placeholder="what changed and why")
        if st.form_submit_button("🔒 Freeze version", type="primary"):
            scored = st.session_state.get(f"classify::{camera}::{feature}")
            stats = classify.stats_for(scored) if scored else {}
            info = versions_mod.freeze(camera, feature, name, notes, stats=stats)
            st.success(
                f"Froze **v{info['number']}** — "
                + ", ".join(f"{c}: {info['counts'].get(c, 0)}" for c in classes)
            )
            st.rerun()

    vl = versions_mod.list_versions(camera, feature)
    if not vl:
        st.info("No versions yet for this feature. Freeze one above once you've labeled some frames.")
        return

    st.subheader(f"History ({len(vl)})")
    st.dataframe(
        [
            {
                "": "▶ active" if v["active"] else "",
                "version": f"v{v['number']}",
                "name": v["name"],
                "created": _fmt(v["created"]),
                **{c: v["counts"].get(c, 0) for c in classes},
                **{f"⭐{c}": v["counts"].get(f"golden_{c}", 0) for c in classes},
                "unlabeled": v["counts"].get("unlabeled", 0),
                "change vs previous": v["delta"],
            }
            for v in reversed(vl)
        ],
        width="stretch",
        hide_index=True,
    )

    st.subheader("Actions")
    for v in reversed(vl):
        with st.expander(
            f"v{v['number']} — {v['name']}"
            + ("  ·  ▶ ACTIVE" if v["active"] else "")
            + f"  ·  {_fmt(v['created'])}"
        ):
            if v["notes"]:
                st.caption(v["notes"])
            st.write(f"**Change vs previous:** {v['delta']}")
            if v["stats"]:
                st.write("**Novelty stats at freeze time:**")
                st.dataframe(
                    [{"method": m, **s} for m, s in v["stats"].items()],
                    width="stretch",
                    hide_index=True,
                )

            ck = f"confirm_revert::{v['id']}"
            a, b, _ = st.columns([1, 1, 3])
            if a.button("⏪ Revert to this", key=f"rev::{v['id']}", disabled=v["active"]):
                st.session_state[ck] = True
            if b.button("📦 Export", key=f"exp::{v['id']}"):
                with st.spinner("Exporting cutouts…"):
                    dest, rep = versions_mod.export(camera, feature, v["id"])
                st.success(f"Exported **{rep['written']}** cutouts → `{dest}`")
                if rep["missing"]:
                    st.warning(f"{len(rep['missing'])} frame(s) missing: {rep['missing'][:5]}")
                if rep["hash_mismatch"]:
                    st.error(
                        f"{len(rep['hash_mismatch'])} frame(s) changed since freeze: "
                        f"{rep['hash_mismatch'][:5]}"
                    )

            if st.session_state.get(ck):
                st.warning(
                    f"Revert the working state to **v{v['number']}**? Current labels and golden "
                    "marks will be replaced by that snapshot. Other saved versions remain available."
                )
                y, n, _ = st.columns([1, 1, 3])
                if y.button("✅ Yes, revert", key=f"yes::{v['id']}"):
                    res = versions_mod.revert(camera, feature, v["id"])
                    st.session_state.pop(ck, None)
                    st.session_state.pop(f"classify::{camera}::{feature}", None)
                    st.success(
                        f"Reverted to v{v['number']}: {res['labels']} labels, "
                        f"{res['goldens']} golden marks."
                    )
                    st.rerun()
                if n.button("Cancel", key=f"no::{v['id']}"):
                    st.session_state.pop(ck, None)
                    st.rerun()
