"""Augmentation ranges: how far the object moves between frames (settings, run, analysis)."""
from __future__ import annotations

import datamodel
import labels
import motion
import vision_settings
from api import jobs
from api.cameras import require_feature
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter()


class RangesBody(BaseModel):
    dx: list[float] | None = None
    dy: list[float] | None = None
    rot: list[float] | None = None


class SettingsBody(BaseModel):
    reference: str | None = None
    source: str = "auto"
    rotation: bool = False
    coverage: float = motion.DEFAULT_COVERAGE
    label: str | None = None
    ranges: RangesBody = RangesBody()


class SaveBody(BaseModel):
    settings: SettingsBody | None = None


def _clean(body: SettingsBody | None) -> dict | None:
    try:
        return motion.clean(body.model_dump() if body else None)
    except motion.SettingsError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _analysis(camera: str, feature: str, settings: dict, coverage: float, label: str | None) -> dict | None:
    sig = motion.current_signature(camera, feature, settings)
    results = motion.load_results(camera, feature, sig) if sig else None
    if results is None:
        return None
    include = None
    if label:
        hmap = labels.hash_map(camera)
        include = {hmap[f] for f, c in labels.current_labels(camera, feature).items() if c == label and f in hmap}
    return motion.analyse(results, coverage=coverage, include=include)


def _state(camera: str, feature: str, coverage: float | None = None, label: str | None = None, override_label: bool = False) -> dict:
    saved = motion.get(camera, feature)
    settings = saved or motion.default_settings()
    cov = settings["coverage"] if coverage is None else coverage
    lab = label if override_label else settings["label"]
    status = motion.results_status(camera, feature)
    return {
        "feature": feature,
        "classes": datamodel.classes_for(camera, feature),
        "settings": settings,
        "saved": saved is not None,
        "reference": motion.reference_frame(camera, feature, settings),
        "has_detector": bool((vision_settings.get(camera, feature)["detector"] or {}).get("exemplars")),
        "results": status,
        "analysis": _analysis(camera, feature, settings, cov, lab) if status == "fresh" else None,
        "coverage_range": list(motion.COVERAGE_RANGE),
    }


@router.get("/cameras/{camera}/augmentation/{feature}")
def get_state(
    camera: str, feature: str,
    coverage: float | None = Query(None), label: str | None = Query(None),
) -> dict:
    """Saved settings, whether results are fresh, and the analysis. ``coverage`` and ``label`` preview
    another selection without saving it (an empty ``label`` means all frames)."""
    require_feature(camera, feature)
    if coverage is not None and not motion.COVERAGE_RANGE[0] <= coverage <= motion.COVERAGE_RANGE[1]:
        raise HTTPException(status_code=422, detail="coverage is out of range.")
    return _state(camera, feature, coverage, label, override_label=label is not None)


@router.put("/cameras/{camera}/augmentation/{feature}")
def put_settings(camera: str, feature: str, body: SaveBody) -> dict:
    require_feature(camera, feature)
    settings = _clean(body.settings)
    if settings and settings["label"] and settings["label"] not in datamodel.classes_for(camera, feature):
        raise HTTPException(status_code=422, detail=f"Unknown class: {settings['label']}")
    if settings and settings["reference"] and settings["reference"] not in datamodel.frames_for_feature(camera, feature):
        raise HTTPException(status_code=422, detail="The reference frame is not a frame of this feature.")
    motion.put(camera, feature, settings)
    return _state(camera, feature)


@router.post("/cameras/{camera}/augmentation/{feature}/run", status_code=202)
def run(camera: str, feature: str) -> dict:
    """Measure every live frame against the reference frame (a background job)."""
    require_feature(camera, feature)
    if not datamodel.frames_for_feature(camera, feature):
        raise HTTPException(status_code=409, detail="This feature has no frames yet.")

    def work(report):
        return motion.run(camera, feature, report)

    return jobs.registry.submit("augmentation", camera, work, feature=feature).to_dict()
