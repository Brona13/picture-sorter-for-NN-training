"""Classify view — mark per-class goldens, refresh scores, triage and label.

Split from a single 462-line module for editability. The private submodules:

  * ``_styles.py``   — static JS/CSS blobs (OK-in-green tint).
  * ``_helpers.py``  — session-state keys, hashes, leaning badge HTML.
  * ``_controls.py`` — Show/Rank/Order controls + filter/sort logic.
  * ``_bulk.py``     — bulk-label expander.
  * ``_grid.py``     — pagination + per-card grid rendering.
  * ``render.py``    — orchestrator; entry point.

``app.py`` still does ``import view_classify`` and calls ``view_classify.render``.
"""
from .render import render

__all__ = ["render"]
