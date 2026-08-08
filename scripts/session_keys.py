"""Session-state key registry — the single source of truth for the
``st.session_state`` slots that cross view module boundaries.

Several slots are written in one view and read in another. The most
load-bearing example: the Classify view caches its last scored
``list[FrameScore]`` under ``classify::<camera>::<feature>``, and the
Versions Freeze form reads that same slot to stamp novelty stats into
the frozen version. Inline f-strings scattered across views make silent
drift too easy — every convention lives here so a rename in one place
can't quietly break another view.
"""
from __future__ import annotations


def classify_scored(camera: str, feature: str) -> str:
    """Classify's cached ``list[FrameScore]`` for a camera+feature.

    Written by :mod:`view_classify`; read by the Versions Freeze form
    (to compute novelty stats at freeze time); popped on Versions revert
    and on ROI delete so a fresh score is recomputed for the next scope.
    """
    return f"classify::{camera}::{feature}"


def classify_show_muted(camera: str, feature: str) -> str:
    """Whether Classify's grid currently includes dedup-muted frames."""
    return f"classify::show-muted::{camera}::{feature}"


def insights_matrices(camera: str, feature: str) -> str:
    """Insights' cached per-method confusion matrices for a camera+feature."""
    return f"insights::{camera}::{feature}"
