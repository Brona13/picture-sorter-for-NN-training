"""Orchestrator: scope caption, frame picker, mode radio, and dispatch."""
from __future__ import annotations

import streamlit as st

import datamodel
import db
import ui_common
from roi import ROI

from . import _draw, _edit, _roi_list
from ._canvas import golden_with_rois


def render(camera: str, product: str | None = None) -> None:
    st.header(f"ROI editor — {camera}" + (f" › {product}" if product else ""))
    frames = datamodel.list_unsorted(camera)
    if not frames:
        st.warning(
            "No frames for this camera yet — add some in **Ingest** first. Any ingested frame "
            "works as the drawing background (same camera, same framing)."
        )
        return

    all_rois = datamodel.load_rois(camera)
    classify_feat = datamodel.classify_feature(camera)
    all_products = datamodel.products(camera)
    # Only the current scope's ROIs are drawn and listed — a product's ROIs are
    # its own (products look different, so the boxes differ too).
    rois = [r for r in all_rois if datamodel.split_feature(r.name)[0] == product]

    _scope_caption(product, classify_feat, all_rois)

    all_names = [p.name for p in frames]
    names, showing_all = _frame_choices(camera, product, all_names)

    frame_name = _frame_picker(camera, product, names, all_names, showing_all)
    frame_path = datamodel.unsorted_dir(camera) / frame_name

    display_width = ui_common.editor_display_width()

    # Draw a brand-new rectangle, or grab an existing one and move/resize it.
    edit_target = _mode_picker(camera, product, rois)

    # In edit mode the target becomes a live canvas object, so don't also bake it
    # into the background — it would show twice, at the old and new positions.
    bg, disp_w, disp_h = golden_with_rois(
        camera,
        frame_path,
        rois,
        display_width,
        skip=edit_target.name if edit_target is not None else None,
    )

    if edit_target is not None:
        _edit.render_edit(camera, edit_target, all_rois, bg, disp_w, disp_h, frame_name)
    else:
        _draw.render_draw_new(
            camera, product, classify_feat, all_products, all_rois,
            bg, disp_w, disp_h, frame_name,
        )

    if product is None and classify_feat:
        _roi_list.render_products_editor(camera, classify_feat, all_rois)

    _roi_list.render_defined_rois(
        camera, product, rois, all_products, all_names, frame_path,
    )


def _scope_caption(
    product: str | None, classify_feat: str | None, all_rois: list[ROI]
) -> None:
    """One-line context at the top of the view — what scope you're in."""
    if product:
        shared_here = [
            r.name for r in all_rois
            if datamodel.split_feature(r.name)[0] is None
            and r.role != "classify"
            and r.products
            and product in r.products
        ]
        st.caption(
            f"Drawing ROIs for product **{product}** — they apply only to its frames."
            + (
                f"  🔗 Shared ROIs also covering it: **{', '.join(shared_here)}** "
                "(edit those at camera level)."
                if shared_here
                else ""
            )
        )
    elif classify_feat:
        st.caption(
            f"Camera level. The product-sorting ROI is **{classify_feat}**; pick a product in "
            "the sidebar to draw that product's own inspection ROIs."
        )


def _frame_choices(
    camera: str, product: str | None, all_names: list[str]
) -> tuple[list[str], bool]:
    """Frames offered as drawing backgrounds.

    A product's ROI wants one of *its* frames — but never leave the editor
    empty: a product with nothing classified yet falls back to the whole inbox.
    Returns ``(names, showing_all)``.
    """
    names = datamodel.frames_of_product(camera, product)
    if not names:
        return all_names, True
    return names, False


def _frame_picker(
    camera: str,
    product: str | None,
    names: list[str],
    all_names: list[str],
    showing_all: bool,
) -> str:
    """Frame selectbox + pin-as-reference button + captions."""
    # Optional pinned reference frame, so the editor always opens on the same picture.
    pinned = db.get_setting(camera, "reference_frame")
    default_idx = names.index(pinned) if pinned in names else 0

    pick, act = st.columns([4, 1])
    frame_name = pick.selectbox("Frame to draw on", names, index=default_idx)
    if product:
        if showing_all:
            st.caption(
                f"No frames are classified as **{product}** yet, so all {len(all_names)} "
                "frames are offered. Classify some in **Classify** to narrow this list."
            )
        else:
            st.caption(
                f"Showing the **{len(names)}** frames classified as **{product}** — "
                "draw this ROI on a picture of the product it belongs to."
            )
    if act.button("📌 Pin as reference", help="Open the editor on this frame by default"):
        db.set_setting(camera, "reference_frame", frame_name)
        st.rerun()
    if pinned:
        st.caption(
            f"📌 Reference frame: `{pinned}`"
            + ("" if pinned in names else "  ⚠️ no longer present — pick another and pin it")
        )
    return frame_name


def _mode_picker(camera: str, product: str | None, rois: list[ROI]) -> ROI | None:
    """Radio between Draw / Move&resize; returns the selected ROI or None."""
    if not rois:
        return None
    mode = st.radio(
        "Mode",
        ["➕ Draw a new ROI", "✥ Move & resize an existing ROI"],
        horizontal=True,
        label_visibility="collapsed",
        key=f"roimode::{camera}::{product}",
    )
    if mode.startswith("✥"):
        by_short = {datamodel.split_feature(r.name)[1]: r for r in rois}
        return by_short[st.selectbox("ROI to adjust", list(by_short))]
    return None
