"""Dedup view — perceptual near-duplicate clustering with DBSCAN.

Split from a single 545-line module for editability, matching
``view_classify/`` and ``view_roi_editor/``. Private submodules:

  * ``_helpers.py``   — session-state key helpers + shared UI constants.
  * ``_controls.py``  — sliders and settings persistence.
  * ``_cluster.py``   — Cluster / Revert buttons and result state machine.
  * ``_scatter.py``   — summary metrics + 2D scatter (Plotly).
  * ``_clusters.py``  — per-cluster expanders + thumbnail rows.
  * ``_apply.py``     — Apply/clear panels for muting.
  * ``render.py``     — orchestrator; entry point.

``app.py`` still does ``import view_dedup`` and calls ``view_dedup.render``.
"""
from .render import render

__all__ = ["render"]
