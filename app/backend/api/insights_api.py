"""Insights: per-method confusion matrices from the persisted scores."""
from __future__ import annotations

import classify
import datamodel
import insights
import labels
from api.cameras import require_feature
from api.classify_api import COLS_OPTIONS, _grid_setting, load_scored
import classify_view as cv
import db
from fastapi import APIRouter, HTTPException

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


@router.get("/cameras/{camera}/insights/cell")
def insights_cell(camera: str, feature: str, method: str, true_cls: str, pred_cls: str) -> dict:
    """Frames behind one confusion-matrix cell, e.g. the false positives."""
    require_feature(camera, feature)
    classes = datamodel.classes_for(camera, feature)
    if true_cls not in classes or pred_cls not in classes:
        raise HTTPException(status_code=422, detail="Unknown class.")
    if method not in classify.methods_available():
        raise HTTPException(status_code=422, detail=f"Unknown method: {method}")
    gold = labels.current_goldens(camera, feature)
    evaluable = insights.evaluable_labels(labels.current_labels(camera, feature), gold)
    results, _, _ = load_scored(camera, feature)
    out = {"items": [], "classes": classes, "methods": classify.methods_available(), "cols": _grid_setting(camera, feature, "cols", COLS_OPTIONS, 4)}
    if results is None:
        return out
    names = set(insights.cell_frames(results, evaluable, method, true_cls, pred_cls))
    for fs in sorted((r for r in results if r.frame in names), key=lambda r: r.frame):
        ms = fs.per_method.get(method)
        out["items"].append(
            {
                "frame": fs.frame,
                "label": evaluable.get(fs.frame),
                "golden": None,  # goldens are excluded from the matrix
                "deleted": db.is_frame_deleted(camera, fs.frame),
                "leanings": {m: p.leaning for m, p in fs.per_method.items()},
                "bars": cv.bars(ms.dists, classes) if ms else None,
                "cluster": None,
            }
        )
    return out
