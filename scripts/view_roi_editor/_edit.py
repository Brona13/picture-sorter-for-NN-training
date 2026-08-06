"""Move & resize an existing ROI with the canvas' transform handles."""
from __future__ import annotations

import streamlit as st
from PIL import Image

import datamodel
import labels
import ui_common
from roi import ROI

from ._canvas import HAS_CANVAS, st_canvas


def render_edit(
    camera: str,
    target: ROI,
    all_rois: list[ROI],
    bg: Image.Image,
    disp_w: int,
    disp_h: int,
    frame_name: str,
) -> None:
    """Canvas + numeric fields + Save. Warns if labels/goldens survive a move.

    The canvas is seeded from the ROI's **saved** geometry, which does not
    change while dragging — so the component isn't re-initialised on the rerun
    that each mouse-up triggers, and the box stays where it was dropped.
    """
    short = datamodel.split_feature(target.name)[1]
    stored = (target.x, target.y, target.w, target.h)
    box = stored

    if HAS_CANVAS:
        try:
            canvas = st_canvas(
                fill_color="rgba(255, 165, 0, 0.2)",
                stroke_width=2,
                stroke_color="#ff3030",
                background_image=bg,
                update_streamlit=True,
                height=disp_h,
                width=disp_w,
                drawing_mode="transform",
                initial_drawing={
                    "version": "4.4.0",
                    "objects": [ui_common.fabric_rect(target, disp_w, disp_h)],
                },
                key=f"canvas-edit::{camera}::{frame_name}::{target.name}",
            )
            st.caption(
                "Drag the box to move it, or pull a corner/edge handle to resize. "
                "Other ROIs stay drawn in green for reference."
            )
            objs = (canvas.json_data or {}).get("objects", []) if canvas else []
            rects = [o for o in objs if o.get("type") == "rect"]
            if rects:
                box = ui_common.box_from_object(rects[0], disp_w, disp_h)
        except Exception as e:  # noqa: BLE001 - any canvas failure -> numbers only
            st.warning(f"Drawing canvas unavailable ({e}). Use the numbers below instead.")
            st.image(bg)
    else:
        st.info("`streamlit-drawable-canvas` not available — use the numbers below.")
        st.image(bg)

    # The fields re-seed whenever the canvas reports a different box (the key
    # changes, so the widget is rebuilt) but keep whatever you type otherwise.
    nonce = "%.4f-%.4f-%.4f-%.4f" % box
    cols = st.columns(4)
    nx = cols[0].number_input("x", 0.0, 1.0, float(box[0]), 0.002,
                              format="%.4f", key=f"ex::{target.name}::{nonce}")
    ny = cols[1].number_input("y", 0.0, 1.0, float(box[1]), 0.002,
                              format="%.4f", key=f"ey::{target.name}::{nonce}")
    nw = cols[2].number_input("w", 0.001, 1.0, float(box[2]), 0.002,
                              format="%.4f", key=f"ew::{target.name}::{nonce}")
    nh = cols[3].number_input("h", 0.001, 1.0, float(box[3]), 0.002,
                              format="%.4f", key=f"eh::{target.name}::{nonce}")
    new_box = (nx, ny, nw, nh)

    # Labels/goldens are keyed by feature NAME, so they survive a move — but they
    # were judged on the old crop. Say so rather than silently keeping them.
    counts = labels.counts(camera, target.name)
    classes = datamodel.classes_for(camera, target.name)
    n_lab = sum(counts.get(c, 0) for c in classes)
    n_gold = sum(counts.get(f"golden_{c}", 0) for c in classes)
    moved = tuple(round(v, 4) for v in new_box) != tuple(round(v, 4) for v in stored)
    if moved and (n_lab or n_gold):
        st.warning(
            f"**{short}** already has {n_lab} labels and {n_gold} golden marks. Moving the "
            "rectangle keeps them, but they were decided on the *previous* crop — re-run "
            "**Refresh scores** and review them afterwards."
        )

    c1, c2 = st.columns([1, 3])
    if c1.button("💾 Save position", type="primary", disabled=not moved):
        for r in all_rois:
            if r.name == target.name:
                r.x, r.y, r.w, r.h = new_box          # geometry only
        datamodel.save_rois(camera, all_rois)
        st.success(f"Moved '{short}' → x={nx:.4f}, y={ny:.4f}, w={nw:.4f}, h={nh:.4f}")
        st.rerun()
    c2.caption(
        "Saved: x=%.4f, y=%.4f, w=%.4f, h=%.4f" % stored
        + ("  ·  unsaved changes" if moved else "  ·  unchanged")
    )
