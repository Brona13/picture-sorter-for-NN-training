"""Which tools have left a trace in a camera, for the muted / colorful icons in the tool bar.

A tool is *used* when it stored something (settings, results, versions, decisions) or when an action made from it
changed pictures (a label, a delete or a mute). Just opening it leaves no trace and does not count. Nothing is
saved here: every answer is derived from existing state, like ``pipeline.py``. Keys are the tool's route path.

The tools that only act on pictures (Scatter, Outliers, Insights, Clusters) are recognised by the page name stored
with their labels (``labels.via``) and deletes (``deleted_frames.source``); see ``VIA_*`` below.
"""
from __future__ import annotations

import chain
import datamodel
import db
import dedup
import dedup_box
import edge_angle
import motion
import pipeline
import versions

# The page names the tools stamp on their labels and deletes. "Dedup" is what the Scatter selection used to write.
VIA_SCATTER = "Scatter"
VIA_CLUSTERS = "Clusters"
VIA_OUTLIERS = "Outliers"
VIA_INSIGHTS = "Insights"
_LEGACY_SCATTER = "Dedup"

TOOLS = (
    "dedup/scatter",
    "dedup/clusters",
    "dedup/outliers",
    "roi",
    "chain",
    "detector",
    "edge-angle",
    "classify",
    "insights",
    "verdict",
    "augmentation",
    "versions",
)


def _vias(camera: str) -> set[str]:
    """Every page name stamped on a current label of the camera."""
    con = db.connect()
    try:
        rows = con.execute("SELECT DISTINCT via FROM labels WHERE camera=?", (camera,)).fetchall()
    finally:
        con.close()
    return {r["via"] for r in rows}


def _delete_sources(camera: str) -> set[str]:
    con = db.connect()
    try:
        rows = con.execute("SELECT DISTINCT source FROM deleted_frames WHERE camera=?", (camera,)).fetchall()
    finally:
        con.close()
    return {r["source"] for r in rows}


def _has_decisions(camera: str) -> bool:
    con = db.connect()
    try:
        return con.execute("SELECT 1 FROM verdict_decisions WHERE camera=? LIMIT 1", (camera,)).fetchone() is not None
    finally:
        con.close()


def used(camera: str) -> dict[str, bool]:
    """``{tool path: has it left a trace on this camera}`` for every tool of the Manipulation and Export bars."""
    features = datamodel.list_features(camera)
    vias = _vias(camera)
    deletes = _delete_sources(camera)

    def acted(*names: str) -> bool:
        return any(n in vias or n in deletes for n in names)

    classify_labels = any(v.startswith("Classify") or v in ("", "Find similar") for v in vias)
    return {
        "dedup/scatter": acted(VIA_SCATTER, _LEGACY_SCATTER),
        "dedup/clusters": acted(VIA_CLUSTERS)
        or any(db.muted_frames(camera, f) or dedup.load_snapshot(camera, f) is not None for f in [*features, *dedup_box.boxes(camera)]),
        "dedup/outliers": acted(VIA_OUTLIERS),
        "roi": bool(features),
        "chain": bool(db.get_setting(camera, chain.SETTING_KEY)),
        "detector": any(pipeline.vision_configured(camera, f) for f in features),
        "edge-angle": any(edge_angle.get(camera, f) is not None for f in features),
        "classify": classify_labels or "user" in deletes or "Classify" in deletes,
        "insights": acted(VIA_INSIGHTS),
        "verdict": _has_decisions(camera),
        "augmentation": any(motion.get(camera, f) is not None for f in features),
        "versions": any(not v["deleted"] for f in [*features, versions.PROJECT] for v in versions.list_versions(camera, f)),
    }
