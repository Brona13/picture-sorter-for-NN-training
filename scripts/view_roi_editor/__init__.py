"""ROI editor view — drag-draw or move/resize rectangles; save as named features.

Split from a single 611-line module for editability. The private submodules:

  * ``_canvas.py``    — canvas-component shim, ``st_canvas`` import, and the
                         background-image renderer that bakes the other ROIs.
  * ``_styles.py``    — inline CSS (multiselect-as-chips tweak).
  * ``_headline.py``  — the HTML for one ROI card's headline (chip + counts).
  * ``_draw.py``      — the *Draw a new ROI* mode.
  * ``_edit.py``      — the *Move & resize an existing ROI* mode.
  * ``_roi_list.py``  — the *Defined ROIs* card list + products editor.
  * ``render.py``     — orchestrator: frame picker, mode radio, dispatch.

``app.py`` still does ``import view_roi_editor`` and calls
``view_roi_editor.render``.
"""
from .render import render

__all__ = ["render"]
