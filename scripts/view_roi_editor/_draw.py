"""Draw a brand-new rectangle and save it as a named feature."""
from __future__ import annotations

import streamlit as st
from PIL import Image

import config
import datamodel
import ui_common
from roi import ROI

from ._canvas import HAS_CANVAS, st_canvas


def render_draw_new(
    camera: str,
    product: str | None,
    classify_feat: str | None,
    all_products: list[str],
    all_rois: list[ROI],
    bg: Image.Image,
    disp_w: int,
    disp_h: int,
    frame_name: str,
) -> None:
    """Canvas / manual box entry + form to name and save the new ROI."""
    st.caption("Existing ROIs are drawn in green. Draw a new rectangle below, name it, and add it.")

    def _manual_box() -> tuple[float, float, float, float]:
        st.image(bg)
        cols = st.columns(4)
        nx = cols[0].number_input("x", 0.0, 1.0, 0.25, 0.01)
        ny = cols[1].number_input("y", 0.0, 1.0, 0.25, 0.01)
        nw = cols[2].number_input("w", 0.01, 1.0, 0.5, 0.01)
        nh = cols[3].number_input("h", 0.01, 1.0, 0.5, 0.01)
        return (nx, ny, nw, nh)

    new_box: tuple[float, float, float, float] | None = None
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
                drawing_mode="rect",
                key=f"canvas::{camera}::{frame_name}",
            )
            objs = (canvas.json_data or {}).get("objects", []) if canvas else []
            rects = [o for o in objs if o.get("type") == "rect"]
            if rects:
                new_box = ui_common.box_from_object(rects[-1], disp_w, disp_h)
        except Exception as e:  # noqa: BLE001 - any canvas/version failure -> manual
            st.warning(f"Drawing canvas unavailable ({e}). Using manual entry instead.")
            new_box = _manual_box()
    else:
        st.info("`streamlit-drawable-canvas` not available — enter ROI coordinates manually (normalised 0-1).")
        new_box = _manual_box()

    with st.form("add_roi", clear_on_submit=False):
        name = st.text_input("Feature name for this ROI", placeholder="e.g. suspension-rod")
        make_classifier, product_csv = False, ""
        shared_with: list[str] = []
        if product is None and classify_feat is None:
            make_classifier = st.checkbox(
                "Make this the **product-sorting** ROI (stage 1)",
                help=(
                    "One per camera. Its classes are your product names, and every frame gets "
                    "sorted into one of them before you inspect quality."
                ),
            )
            product_csv = st.text_input(
                "Product names (comma-separated)", placeholder="type-A, type-B, type-C"
            )
        elif product is None and all_products:
            shared_with = st.multiselect(
                "Applies to products (leave empty = all products)",
                all_products,
                help=(
                    "Pick two or more when the same region looks identical on those products — "
                    "they then share ONE golden set, one label set and one export. Leave empty "
                    "for a ROI that covers every frame of this camera."
                ),
            )
        submitted = st.form_submit_button("➕ Add / update ROI")
    if submitted:
        short = name.strip()
        new_products = [p.strip() for p in product_csv.split(",") if p.strip()]
        if not short:
            st.error("Please enter a feature name.")
        elif new_box is None:
            st.error("Draw a rectangle first.")
        elif datamodel.FEATURE_SEP in short:
            st.error(f"`{datamodel.FEATURE_SEP}` is reserved — please pick a name without it.")
        elif make_classifier and len(new_products) < 2:
            st.error("A product-sorting ROI needs at least two product names.")
        else:
            x, y, w, h = new_box
            full = datamodel.compose_feature(product, short)
            updated = [r for r in all_rois if r.name != full]
            updated.append(
                ROI(
                    full, x, y, w, h,
                    role="classify" if make_classifier else "quality",
                    classes=new_products if make_classifier else None,
                    products=shared_with or None,
                )
            )
            datamodel.save_rois(camera, updated)
            st.success(
                f"Saved ROI '{short}'"
                + (f" under product '{product}'" if product else "")
                + (f" — products: {', '.join(new_products)}" if make_classifier else "")
                + f" → {config.ROIS_FILENAME}"
            )
            st.rerun()
