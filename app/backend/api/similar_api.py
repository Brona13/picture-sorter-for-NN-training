"""Find-similar batch labeling: neighbours of a labeled seed, and applying the seed's label."""
from __future__ import annotations

import datamodel
import db
import embedding
import labels
import neighbors
from api import jobs
from api.cameras import require_feature
from api.frames_api import frame_path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class SimilarBody(BaseModel):
    feature: str
    frame: str
    method: str
    limit: int = neighbors.DEFAULT_LIMIT


@router.post("/cameras/{camera}/classify/similar", status_code=202)
def find_similar(camera: str, body: SimilarBody) -> dict:
    require_feature(camera, body.feature)
    frame_path(camera, body.frame)
    if not embedding.backbones():
        raise HTTPException(status_code=409, detail="Find similar unavailable: no_embeddings")
    if body.method not in embedding.backbones():
        raise HTTPException(status_code=422, detail=f"Unknown embedding: {body.method}")
    if not neighbors.LIMIT_RANGE[0] <= body.limit <= neighbors.LIMIT_RANGE[1]:
        raise HTTPException(status_code=422, detail="limit is out of range.")
    seed_label = labels.current_labels(camera, body.feature).get(body.frame)
    if seed_label is None:
        raise HTTPException(status_code=409, detail="Label this frame first: its label is what gets applied to the matches.")
    if body.frame in db.deleted_frames_of(camera):
        raise HTTPException(status_code=409, detail="This frame is deleted.")

    def work(report):
        def progress(done: int, total: int) -> None:
            report({"phase": "embedding", "done": done, "total": total})

        ranked = neighbors.find_similar(
            camera, body.feature, body.frame, method=body.method,
            muted=db.muted_frames(camera, body.feature), limit=body.limit, progress_cb=progress,
        )
        return {
            "seed": {"frame": body.frame, "label": seed_label},
            "method": body.method,
            "neighbors": [{"frame": f, "distance": d} for f, d in ranked],
            "classes": datamodel.classes_for(camera, body.feature),
        }

    return jobs.registry.submit("classify_similar", camera, work, feature=body.feature).to_dict()


class LabelFramesBody(BaseModel):
    feature: str
    frames: list[str]
    cls: str


@router.post("/cameras/{camera}/classify/label-frames")
def label_frames(camera: str, body: LabelFramesBody) -> dict:
    require_feature(camera, body.feature)
    if body.cls not in datamodel.classes_for(camera, body.feature):
        raise HTTPException(status_code=422, detail=f"Unknown class: {body.cls}")
    labeled, skipped = neighbors.apply_label(camera, body.feature, body.frames, body.cls)
    return {"labeled": labeled, "skipped": skipped, "counts": labels.counts(camera, body.feature)}
