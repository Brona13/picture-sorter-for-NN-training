"""Dedup boxes on the Chain (v1.93.0): near-duplicate clustering with mutes that belong to the box.

A Dedup box (``dedup:N`` in the flow graph) takes pictures in and passes pictures on, minus the ones it muted.

  * Its input is the whole camera (no line), a Picture edits box (the embeddings are made from the edited picture),
    or one dot of a Classifier (only the classified pictures of that class, or of all of them).
  * Its mutes are stored per box (the ``dedup_mute`` rows have the box id as their feature), so two boxes on one camera
    mute differently. Clusters, the scatter map and the settings are keyed by the box id as well.
  * A Classifier is fed by at most one Dedup box (the setting ``roi.dedup.<feature>``): the Classifier hides the frames
    that box muted (``db.muted_frames``), so a Dedup box right after Ingest thins out the whole dataset.

The clustering code is the one that worked per ROI: it only needs a "feature" name to key its data by, and the box id is
one. A box has no labels of its own: marks (label, golden) come from the Classifier it reads, if any.
"""
from __future__ import annotations

import applog
import config
import datamodel
import db
import flow
import lines

INPUT_KEY = db.DEDUP_INPUT_KEY


class DedupBoxError(ValueError):
    """The Dedup box cannot be set up that way."""


def is_box(feature: str) -> bool:
    return flow.kind_of(feature) == "dedup"


def exists(camera: str, feature: str) -> bool:
    return is_box(feature) and feature in flow.load_graph(camera)["nodes"]


def boxes(camera: str) -> list[str]:
    return sorted(i for i, n in flow.load_graph(camera)["nodes"].items() if n["kind"] == "dedup")


def source_of(camera: str, box: str, graph: dict | None = None) -> dict | None:
    """``{"feature", "dot"}`` when the box reads one dot of a Classifier, else ``None``."""
    node = (graph or flow.load_graph(camera))["nodes"].get(box) or {}
    src = node.get("source")
    return src if isinstance(src, dict) and src.get("feature") and src.get("dot") else None


def label_source(camera: str, feature: str) -> str:
    """The feature whose labels and goldens mark the pictures of ``feature``: a box reads its Classifier's.
    A box that reads no Classifier has no labels of its own: it acts through the whole-frame feature (no classes, so
    no labelling, but deleting works), because the picture actions of the Classify API need a real feature."""
    if is_box(feature):
        src = source_of(camera, feature)
        return src["feature"] if src else config.WHOLE_FRAME_FEATURE
    return feature


@applog.timed("dedup.frames")
def frames(camera: str, box: str) -> list[str]:
    """The pictures the box sees: what its input passes on (Ingest, a Picture edits box, a detector, or one dot of a
    Classifier); no line into it, no pictures. Deleted ones never. Worked out once per Chain canvas (render snapshot)."""
    return datamodel._snapshot_value(("dedup_frames", camera, box), lambda: flow.node_frames(camera, box))


def inputs_of(camera: str, feature: str) -> list[str]:
    """The Dedup boxes a Classifier reads through (its plain input, v1.134.0: several, its pictures are their union). The
    setting holds one box id (older versions) or a JSON list. Boxes with a line into a class dot are in ``db.feeding_boxes``."""
    return db.dedup_inputs(camera, feature)


def input_of(camera: str, feature: str) -> str | None:
    """The first Dedup box a Classifier reads through, or ``None``."""
    boxes = inputs_of(camera, feature)
    return boxes[0] if boxes else None


def fed_by(camera: str) -> dict[str, list[str]]:
    """box id -> the Classifiers it feeds."""
    out: dict[str, list[str]] = {}
    for roi in datamodel.load_rois(camera):
        for box in db.feeding_boxes(camera, roi.name):
            out.setdefault(box, []).append(roi.name)
    return out


def set_input(camera: str, feature: str, box: str | None, remove: bool = False) -> None:
    """Add ``box`` to the Dedup boxes a Classifier reads through (several are allowed, the Classifier gets the union of
    their pictures). ``remove`` takes that one box away; ``box`` ``None`` removes them all."""
    if datamodel.get_roi(camera, feature) is None:
        raise DedupBoxError(f"Unknown ROI: {feature}")
    if box is None:
        db.delete_setting(camera, f"{INPUT_KEY}{feature}")
        return
    boxes = inputs_of(camera, feature)
    if remove:
        db.set_dedup_inputs(camera, feature, [b for b in boxes if b != box])
        return
    if not exists(camera, box):
        raise DedupBoxError(f"{box} is not a Dedup box.")
    src = source_of(camera, box)
    if src and src["feature"] == feature:
        raise DedupBoxError(f"{box} reads {feature}, so it cannot feed it back.")
    if box not in boxes:
        db.set_dedup_inputs(camera, feature, [*boxes, box])


def drop_box(camera: str, box: str) -> dict[str, int]:
    """Forget everything a deleted Dedup box held: mutes, clusters, scatter maps, settings and the Classifiers it fed."""
    for roi in datamodel.load_rois(camera):
        boxes = inputs_of(camera, roi.name)
        if box in boxes:
            db.set_dedup_inputs(camera, roi.name, [b for b in boxes if b != box])
    con = db.connect()
    try:
        out = {"mutes": con.execute("DELETE FROM dedup_mute WHERE camera=? AND feature=?", (camera, box)).rowcount}
        con.execute("DELETE FROM cluster_snapshot WHERE camera=? AND feature=?", (camera, box))
        con.execute("DELETE FROM scatter_cache WHERE camera=? AND feature=?", (camera, box))
        con.execute("DELETE FROM settings WHERE camera=? AND key LIKE ? ESCAPE '\\'", (camera, "dedup.%." + box.replace("_", "\\_").replace("%", "\\%")))
        con.commit()
    finally:
        con.close()
    return out
