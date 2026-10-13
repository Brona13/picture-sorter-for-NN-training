"""Insights: per-method confusion matrices from the persisted scores."""
from __future__ import annotations

import classify
import datamodel
import insights
import labels
from api.cameras import require_feature
from api.classify_api import load_scored
from fastapi import APIRouter

router = APIRouter()


@router.get("/cameras/{camera}/insights")
def insights_for(camera: str, feature: str) -> dict:
    require_feature(camera, feature)
    classes = datamodel.classes_for(camera, feature)
    methods = classify.methods_available()
    gold = labels.current_goldens(camera, feature)
    evaluable = insights.evaluable_labels(labels.current_labels(camera, feature), gold)
    have = [c for c in classes if gold.get(c)]
    out = {
        "feature": feature,
        "classes": classes,
        "methods": methods,
        "goldens_in": have,
        "evaluable": len(evaluable),
        "reason": None,
        "has_results": False,
        "matrices": {},
    }
    if len(have) < 2:
        out["reason"] = "needs_two_golden_classes"
        return out
    if not evaluable:
        out["reason"] = "no_held_out_labels"
        return out
    results, _, _ = load_scored(camera, feature)
    if results is None:
        return out
    out["has_results"] = True
    for m in methods:
        matrix, skipped = insights.build_matrix(results, evaluable, classes, m)
        out["matrices"][m] = {"matrix": matrix, "skipped": skipped, **insights.summarize(matrix, classes)}
    return out
