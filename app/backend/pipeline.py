"""Where each ROI (feature) stands in the curation pipeline, derived from what is already stored.

Nothing here is saved: every stage is computed from existing state (settings, labels, goldens, mutes,
cached results, versions and the export folders), so it can never disagree with the pages that own that
state. The Overview page shows the stages of every ROI; the step bar on the other pages shows the one
being worked on. A stage's ``view`` is the page that does it, so a click resumes the work there.
"""
from __future__ import annotations

import classify
import classify_view as cv
import datamodel
import db
import dedup
import edge_angle
import engine
import labels
import motion
import versions
import vision_settings

# id, label, page that does it, optional. The order is the usual order of work.
STAGES = [
    ("dedup", "Dedup", "dedup", True),
    ("roi", "ROI", "roi", False),
    ("vision", "Filter & detector", "detector", True),
    ("labeled", "Labels", "classify", False),
    ("goldens", "Goldens", "classify", False),
    ("scored", "Scores", "classify", False),
    ("edge", "Edge angle", "edge-angle", True),
    ("augment", "Augmentation", "augmentation", True),
    ("version", "Version", "versions", False),
    ("exported", "Export", "versions", False),
]

DONE, PARTIAL, TODO, STALE = "done", "partial", "todo", "stale"


def _vision_configured(camera: str, feature: str) -> bool:
    s = vision_settings.get(camera, feature)
    return bool(s["filter"] or (s["mask"] and s["mask"]["enabled"]) or (s["detector"] and s["detector"]["exemplars"]))


def _scored_state(camera: str, feature: str, gold: dict[str, list[str]]) -> str:
    sigs = db.results_signatures(camera, feature, classify._roi_cache_key(engine.resolve_roi(camera, feature), camera, feature))
    if sigs is None:
        return TODO
    return DONE if sigs[0] == cv.golden_signature(gold) else STALE


def _per_class(counts: dict[str, int], classes: list[str], prefix: str = "") -> tuple[int, str]:
    have = sum(1 for c in classes if counts.get(f"{prefix}{c}", 0) > 0)
    text = " · ".join(f"{c} {counts.get(f'{prefix}{c}', 0)}" for c in classes)
    return have, text


def stages(camera: str, feature: str, *, counts: dict[str, int] | None = None, version_list: list[dict] | None = None) -> dict:
    """The pipeline state of one feature: ``{"stages": [...], "next": id | None, "frames", "labeled"}``.

    ``counts`` (``labels.counts``) and ``version_list`` (``versions.list_versions``) may be passed by a
    caller that has them already.
    """
    classes = datamodel.classes_for(camera, feature)
    counts = counts if counts is not None else labels.counts(camera, feature)
    gold = labels.current_goldens(camera, feature)
    vlist = [v for v in (version_list if version_list is not None else versions.list_versions(camera, feature)) if v["deleted"] is None]
    labeled = sum(counts.get(c, 0) for c in classes)
    total = counts.get("total", 0)
    classes_labeled, labels_text = _per_class(counts, classes)
    classes_golden, golden_text = _per_class(counts, classes, "golden_")

    def status_of(have: int) -> str:
        return DONE if classes and have == len(classes) else PARTIAL if have > 0 else TODO

    version = next((v for v in vlist if v["active"]), vlist[-1] if vlist else None)
    project = [v for v in versions.list_versions(camera, versions.PROJECT) if v["deleted"] is None]
    latest = next((v for v in project if v["active"]), project[-1] if project else None)
    exported = latest is not None and versions.export_dir(camera, latest["number"], latest["name"]).is_dir()
    edge_rule = edge_angle.get(camera, feature)
    edge_fresh = edge_rule is not None and edge_angle.results_status(camera, feature) == "fresh"
    aug = motion.get(camera, feature)
    aug_ranges = bool(aug and any(aug["ranges"].values()))
    scored = _scored_state(camera, feature, gold) if classes_golden else TODO
    muted = len(db.muted_frames(camera, feature))
    clustered = dedup.load_snapshot(camera, feature) is not None

    state: dict[str, tuple[str, str]] = {
        "roi": (DONE, ""),
        "vision": (DONE if _vision_configured(camera, feature) else TODO, ""),
        "dedup": (DONE if muted or clustered else TODO, f"{muted} muted" if muted else ""),
        "labeled": (status_of(classes_labeled), f"{labeled} of {total} · {labels_text}" if labeled else ""),
        "goldens": (status_of(classes_golden), golden_text if classes_golden else ""),
        "scored": (scored, "goldens changed since" if scored == STALE else ""),
        "edge": (DONE if edge_fresh else PARTIAL if edge_rule else TODO, "" if edge_fresh or not edge_rule else "not measured yet"),
        "augment": (DONE if aug_ranges else PARTIAL if aug else TODO, "" if aug_ranges or not aug else "no ranges saved yet"),
        "version": (DONE if version else TODO, f"v{version['number']}" if version else ""),
        "exported": (DONE if exported else TODO, f"project v{latest['number']}" if exported else ""),
    }
    out = [
        {"id": sid, "label": label, "view": view, "optional": optional, "status": state[sid][0], "detail": state[sid][1]}
        for sid, label, view, optional in STAGES
    ]
    nxt = next((s["id"] for s in out if not s["optional"] and s["status"] != DONE), None)
    return {"feature": feature, "frames": total, "labeled": labeled, "next": nxt, "stages": out}
