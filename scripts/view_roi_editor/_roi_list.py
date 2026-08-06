"""*Defined ROIs* card list + the small *Products* editor above it.

Each ROI card is a bordered container with:
  * headline (thumb + name + scope chip + counts) — HTML from ``_headline``
  * tertiary trash button
  * "Applies to products" multiselect (camera-level quality ROIs only,
    save-on-change via ``_save_products``)
  * an inline delete-confirm block appended below the card
"""
from __future__ import annotations

from pathlib import Path

import streamlit as st

import datamodel
import labels
import ui_common
import versions
from roi import ROI

from ._headline import roi_headline
from ._styles import MULTISELECT_CHIPS_CSS


def _save_products(camera: str, roi_name: str) -> None:
    """Persist an 'Applies to products' change straight away (widget callback)."""
    selected = list(st.session_state.get(f"prod::{roi_name}", []))
    rois = datamodel.load_rois(camera)
    for r in rois:
        if r.name == roi_name:
            r.products = selected or None
    datamodel.save_rois(camera, rois)
    st.toast(
        f"'{datamodel.split_feature(roi_name)[1]}' → "
        + (", ".join(selected) if selected else "all products")
        + " · re-run Refresh scores in Classify"
    )


def render_products_editor(
    camera: str, classify_feat: str, all_rois: list[ROI]
) -> None:
    """Small expander to add/rename/remove the classify ROI's product names."""
    with st.expander(f"Products — classes of '{classify_feat}'"):
        current = datamodel.classes_for(camera, classify_feat)
        edited = st.text_input(
            "Product names (comma-separated)", value=", ".join(current), key="products_edit"
        )
        st.caption(
            "Adding a product makes it available in the sidebar. Removing one does **not** "
            "delete its labels or ROIs — they simply stop being offered."
        )
        if st.button("Save products"):
            wanted = [p.strip() for p in edited.split(",") if p.strip()]
            if len(wanted) < 2:
                st.error("Keep at least two products.")
            else:
                updated = []
                for r in all_rois:
                    if r.name == classify_feat:
                        r.classes = wanted
                    updated.append(r)
                datamodel.save_rois(camera, updated)
                st.success(f"Products: {', '.join(wanted)}")
                st.rerun()


def render_defined_rois(
    camera: str,
    product: str | None,
    rois: list[ROI],
    all_products: list[str],
    all_names: list[str],
    frame_path: Path,
) -> None:
    """Card list of the ROIs in the current scope with per-card controls."""
    if not rois:
        return
    st.subheader("Defined ROIs")
    st.caption(
        "Product changes save as you make them. Deleting a ROI also removes its labels, "
        "goldens and versions — that can't be undone."
    )
    # A ROI limited to products can only see frames that HAVE a product, so a
    # freshly ingested batch makes its count differ from the camera total.
    # Say why, rather than let two honest numbers look like a contradiction.
    if all_products:
        assigned = set()
        for p in all_products:
            assigned.update(datamodel.frames_of_product(camera, p))
        unclassified = len(all_names) - len(assigned)
        if unclassified:
            st.info(
                f"**{unclassified} of {len(all_names)} frames have no product yet.** A ROI "
                "limited to products only covers frames that have been sorted, which is why "
                "its count is lower than the camera's total. Sort them in **Classify** "
                "(*All frames — product sort*) and they'll appear here too."
            )
    st.html(MULTISELECT_CHIPS_CSS)

    try:
        frame_mtime = frame_path.stat().st_mtime
    except OSError:
        frame_mtime = 0.0
    for r in rois:
        _render_card(
            camera, product, r, all_products, all_names, frame_path, frame_mtime
        )


def _render_card(
    camera: str,
    product: str | None,
    r: ROI,
    all_products: list[str],
    all_names: list[str],
    frame_path: Path,
    frame_mtime: float,
) -> None:
    """One ROI card: headline, trash, optional products multiselect, delete confirm."""
    short = datamodel.split_feature(r.name)[1]
    owner = datamodel.split_feature(r.name)[0]
    confirm_key = ui_common.confirm_delete_key(camera, r.name)

    try:
        thumb = ui_common.thumb_data_uri(
            str(frame_path), ui_common.roi_key(r), frame_mtime
        )
    except Exception:  # noqa: BLE001 - a preview is never worth a crash
        thumb = None

    with st.container(border=True):
        bcol, dcol = st.columns([9, 1], vertical_alignment="center")
        with bcol:
            # st.html (not st.markdown) — markdown's sanitiser strips <img>.
            st.html(roi_headline(camera, r, short, owner, thumb, len(all_names)))
        with dcol:
            if st.button(
                "🗑", key=f"del::{r.name}", type="tertiary", help=f"Delete '{short}'"
            ):
                st.session_state[confirm_key] = True

        # Re-assign an existing camera-level quality ROI without redrawing it.
        # Only the frame set changes: labels/goldens/versions are keyed by
        # feature name, so narrowing merely hides frames and is reversible.
        if product is None and all_products and r.role != "classify":
            lcol, mcol = st.columns([1, 7], vertical_alignment="center")
            lcol.html(
                "<div style='font-size:12px;opacity:.6;text-align:right;"
                "padding-right:6px'>Applies to</div>"
            )
            mcol.multiselect(
                "Applies to products",
                all_products,
                default=[p for p in (r.products or []) if p in all_products],
                key=f"prod::{r.name}",
                on_change=_save_products,
                args=(camera, r.name),
                placeholder="every product — pick some to share with just those",
                label_visibility="collapsed",
            )

    if st.session_state.get(confirm_key):
        _render_delete_confirm(camera, r, short, confirm_key)


def _render_delete_confirm(camera: str, r: ROI, short: str, confirm_key: str) -> None:
    """Yellow warning + Yes/Cancel buttons. Delete purges labels + goldens + versions."""
    gone = labels.counts(camera, r.name)
    gone_classes = datamodel.classes_for(camera, r.name)
    st.warning(
        f"Delete **{short}** and permanently remove its "
        f"{sum(gone.get(c, 0) for c in gone_classes)} labels, "
        f"{sum(gone.get(f'golden_{c}', 0) for c in gone_classes)} golden marks and "
        f"{len(versions.list_versions(camera, r.name))} versions?"
    )
    d1, d2, _ = st.columns([1, 1, 4])
    if d1.button("✅ Yes, delete", key=f"yes::{r.name}"):
        datamodel.delete_roi(camera, r.name)
        db_removed = labels.purge_feature(camera, r.name)
        st.session_state.pop(confirm_key, None)
        st.session_state.pop(f"classify::{camera}::{r.name}", None)
        ui_common.clear_ranked(camera, r.name)
        st.success(
            f"Deleted '{r.name}': removed "
            f"{db_removed['labels']} labels / {db_removed['goldens']} golden marks / "
            f"{db_removed['versions']} versions / "
            f"{db_removed.get('settings', 0)} settings."
        )
        st.rerun()
    if d2.button("Cancel", key=f"no::{r.name}"):
        st.session_state.pop(confirm_key, None)
        st.rerun()
