"""Insights: per-method confusion matrices from the persisted scores. The pictures behind a cell are the Classify grid's
Show entries (``classify_view.matrix_view_name``), which each matrix reports for its cells."""
from __future__ import annotations

import classify
import classify_view as cv
import datamodel
import db
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
    methods = [m for m in classify.methods_available() if m == cv.MATRIX_METHOD]  # one method for now (ResNet50)
    gold = labels.current_goldens(camera, feature)
    muted = db.muted_frames(camera, feature)  # hidden from this Classifier, so not part of the picture the matrix describes
    evaluable = {
        f: c for f, c in insights.evaluable_labels(labels.current_labels(camera, feature), gold).items() if f not in muted
    }
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
    if not methods:
        out["reason"] = "method_off"  # the matrix method is not switched on (Configuration)
        return out
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
        out["matrices"][m] = {
            "matrix": matrix,
            "skipped": skipped,
            "views": {t: {p: cv.matrix_view_name(m, t, p, classes) for p in classes} for t in classes},  # the Show entry of each cell
            **insights.summarize(matrix, classes),
        }
    return out
