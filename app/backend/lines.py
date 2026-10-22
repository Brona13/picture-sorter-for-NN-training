"""What a line on the Chain carries, and which lines fit (see ``plans/chain-redesign-plan-2026-10-22.md``).

A line carries a **frame set** (which pictures) and a **picture** (what they look like at that point), or a measured
value. Every box kind says which of these it gives on its output and which it takes on its input. A line fits when the
output type is one the input takes.

The frame-set rule for a classifier: a class dot passes the frames labelled with that class; the "all" dot passes every
labelled frame and no unlabelled one. Deleted frames (the bin) and frames muted by a Dedup box are never passed.
"""
from __future__ import annotations

import datamodel
import db
import labels

FRAMES = "frames"      # a set of pictures, each with its (edited) picture
PICTURE = "picture"    # one picture stream with no frame selection of its own (a box reading the whole camera)
POINT = "point"        # a detector target: position, angle, size
VALUE = "value"        # a number made by a Calculate box
VERDICT = "verdict"    # pass / fail made by an Evaluation box

ALL_DOT = "all"

# Box kind -> what its output gives / what its input takes. A frame set also serves as a picture.
GIVES = {
    "ingest": {FRAMES, PICTURE},
    "roi": {FRAMES, PICTURE},
    "classify": {FRAMES, PICTURE},
    "crop": {PICTURE},
    "detector": {PICTURE, POINT},
    "calc": {VALUE},
    "evaluation": {VERDICT},
    "dedup": {FRAMES, PICTURE},  # the pictures it sees, minus the ones it muted
}
TAKES = {
    "roi": {FRAMES, PICTURE},
    "classify": {FRAMES, PICTURE, VERDICT},
    "crop": {FRAMES, PICTURE, POINT},
    "detector": {FRAMES, PICTURE},
    "calc": {POINT},
    "evaluation": {VALUE},
    "dedup": {FRAMES, PICTURE},
}
NAMES = {
    "ingest": "Ingest", "roi": "a Classifier", "classify": "a Classify box", "crop": "Picture edits",
    "detector": "a detector", "calc": "Calculate", "evaluation": "Evaluation", "dedup": "a Dedup box",
}
TYPE_NAMES = {FRAMES: "frames", PICTURE: "a picture", POINT: "a target point", VALUE: "a number", VERDICT: "a verdict"}


def line_error(source_kind: str, target_kind: str, carries: str | None = None) -> str | None:
    """``None`` when a line from a box of ``source_kind`` to one of ``target_kind`` fits, else why it does not.

    ``carries`` narrows the output to one type, for a dot that gives only that (a detector target dot gives a point)."""
    gives = GIVES.get(source_kind)
    takes = TAKES.get(target_kind)
    src, dst = NAMES.get(source_kind, source_kind), NAMES.get(target_kind, target_kind)
    if gives is None:
        return f"{src} gives nothing to draw a line from."
    if takes is None:
        return f"{dst} takes no line."
    offered = {carries} if carries else gives
    if offered & takes:
        return None
    offered_names = " or ".join(TYPE_NAMES[t] for t in sorted(offered))
    takes_names = " or ".join(TYPE_NAMES[t] for t in sorted(takes))
    return f"{src[0].upper()}{src[1:]} gives {offered_names}, but {dst} takes {takes_names}."


def classified_frames(camera: str, feature: str) -> list[str]:
    """Frames of ``feature`` that carry a label, still in the inbox, not deleted, not muted by Dedup."""
    current = labels.current_labels(camera, feature)
    deleted = db.deleted_frames_of(camera)
    muted = db.muted_frames(camera, feature)
    return [f for f in datamodel.frames_for_feature(camera, feature) if f in current and f not in deleted and f not in muted]


def frames_on_dot(camera: str, feature: str, dot: str) -> list[str]:
    """The frames a classifier's dot passes on: one class, or ``ALL_DOT`` (every classified frame, no unlabelled one)."""
    if dot == ALL_DOT:
        return classified_frames(camera, feature)
    if dot not in datamodel.classes_for(camera, feature):
        raise ValueError(f"{feature} has no class {dot}.")
    current = labels.current_labels(camera, feature)
    return [f for f in classified_frames(camera, feature) if current[f] == dot]
