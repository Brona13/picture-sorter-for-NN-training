"""Small pure helpers used across the Classify submodules."""
from __future__ import annotations

import classify
import datamodel
import ui_common


def golden_signature(gold: dict[str, list[str]]) -> str:
    """Stable fingerprint of the golden sets, to detect 'scores are stale'."""
    return "|".join(f"{cls}:{','.join(sorted(gold.get(cls, [])))}" for cls in sorted(gold))


def frames_signature(camera: str, feature: str) -> str:
    """Fingerprint of the frame set, to detect ingest/delete since last score."""
    return ",".join(sorted(datamodel.frames_for_feature(camera, feature)))


def leaning_html(fs: classify.FrameScore, methods: list[str], classes: list[str]) -> str:
    """Compact per-method leaning badges, e.g.  OK · OK · NG."""
    chips = []
    for m in methods:
        ms = fs.per_method.get(m)
        if ms is None or ms.leaning is None:
            chips.append("<span style='opacity:.45'>–</span>")
            continue
        color = ui_common.class_color(ms.leaning, classes)
        chips.append(
            f"<span style='background:{color};color:#fff;padding:1px 5px;"
            f"border-radius:3px;font-size:11px'>{ms.leaning}</span>"
        )
    return " ".join(chips)
