"""Outlier scoring over a feature's embeddings (a job; embeddings come from the shared cache)."""
from __future__ import annotations

import datamodel
import dedup_box
import embedding
import methods_config
import outliers
from api import jobs
from api.dedup_api import marks_for, require_box
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class OutlierBody(BaseModel):
    feature: str
    method: str
    k: int = outliers.DEFAULT_K


@router.post("/cameras/{camera}/dedup/outliers", status_code=202)
def run_outliers(camera: str, body: OutlierBody) -> dict:
    require_box(camera, body.feature)
    if not embedding.backbones():
        raise HTTPException(status_code=409, detail="Outlier scoring unavailable: no_embeddings")
    if body.method not in methods_config.active_backbones():
        raise HTTPException(status_code=422, detail=f"Embedding not available (switched off in Configuration?): {body.method}")
    if not outliers.K_RANGE[0] <= body.k <= outliers.K_RANGE[1]:
        raise HTTPException(status_code=422, detail="k is out of range.")

    def work(report):
        def progress(done: int, total: int) -> None:
            report({"phase": "embedding", "done": done, "total": total})

        ranked, summ = outliers.compute(camera, body.feature, method=body.method, k=body.k, progress_cb=progress)
        frames = [f for f, _ in ranked]
        return {
            "method": body.method,
            "k": body.k,
            "scores": [{"frame": f, "score": s} for f, s in ranked],
            "summary": summ,
            "marks": marks_for(camera, body.feature, frames),
            "classes": datamodel.classes_for(camera, dedup_box.label_source(camera, body.feature)),
        }

    return jobs.registry.submit("dedup_outliers", camera, work, feature=body.feature).to_dict()
