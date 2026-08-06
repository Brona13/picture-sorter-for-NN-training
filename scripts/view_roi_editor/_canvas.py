"""``streamlit-drawable-canvas`` compatibility shim, import, and background renderer.

Shim explanation: the canvas package (0.9.3) calls
``streamlit.elements.image.image_to_url``, which newer Streamlit versions
removed/relocated (with a changed signature). We restore a function on the old
path that registers the (already-resized) background image with Streamlit's
MediaFileManager and returns the served ``/media/...`` URL — which is what the
canvas frontend needs. A ``data:`` URL does not render in this component.

``HAS_CANVAS`` gates both edit and draw modes. When False, ``st_canvas`` is
``None`` but importing it is safe; the render functions branch on the flag.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

import engine
import ui_common
from roi import ROI


def _install_image_to_url_shim() -> None:
    import streamlit.elements.image as st_image_mod

    if hasattr(st_image_mod, "image_to_url"):
        return

    import io

    from streamlit import runtime

    def image_to_url(image, width, clamp, channels, output_format, image_id):  # noqa: ANN001
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        if runtime.exists():
            return runtime.get_instance().media_file_mgr.add(
                buf.getvalue(), "image/png", image_id
            )
        return ""

    st_image_mod.image_to_url = image_to_url


try:
    _install_image_to_url_shim()
    from streamlit_drawable_canvas import st_canvas

    HAS_CANVAS = True
except Exception:  # pragma: no cover - depends on install/version
    st_canvas = None  # type: ignore[assignment]
    HAS_CANVAS = False


def golden_with_rois(
    camera: str,
    frame_path: Path,
    rois: list[ROI],
    display_width: int,
    skip: str | None = None,
) -> tuple[Image.Image, int, int]:
    """Frame scaled to ``display_width`` with existing ROIs drawn on it.

    ``skip`` omits one ROI by name — used in edit mode, where that ROI is a live
    canvas object instead and would otherwise appear twice.
    """
    img = engine.curation.load_image(frame_path)
    pil = ui_common.bgr_to_pil(img)
    ratio = display_width / pil.width
    disp_w, disp_h = display_width, max(1, int(pil.height * ratio))
    pil = pil.resize((disp_w, disp_h))
    draw = ImageDraw.Draw(pil)
    for r in rois:
        if r.name == skip:
            continue
        x0, y0 = int(r.x * disp_w), int(r.y * disp_h)
        x1, y1 = int((r.x + r.w) * disp_w), int((r.y + r.h) * disp_h)
        draw.rectangle([x0, y0, x1, y1], outline=(0, 200, 0), width=2)
        draw.text((x0 + 3, y0 + 2), r.name, fill=(0, 200, 0))
    return pil, disp_w, disp_h
