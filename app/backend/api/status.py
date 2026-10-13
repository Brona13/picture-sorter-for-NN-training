"""Per-camera status: frame/feature counts and one row per ROI."""
from __future__ import annotations

import config
import datamodel
import labels
import versions
from api.cameras import require_camera
from fastapi import APIRouter

router = APIRouter()


@router.get("/cameras/{camera}/status")
def camera_status(camera: str) -> dict:
    require_camera(camera)
    # One request-scoped snapshot so repeated frame/ROI lookups hit the disk once.
    with datamodel.render_snapshot():
        frames = len(datamodel.list_unsorted(camera))
        rois = datamodel.load_rois(camera)
        products = datamodel.products(camera)
        names = [roi.name for roi in rois]
        label_states, golden_states = labels.current_states_for_features(camera, names)
        summaries = versions.summaries(camera, names)

        features = []
        for r in rois:
            owner, short = datamodel.split_feature(r.name)
            classes = list(r.classes) if r.classes else list(config.CLASSES)
            c = labels.counts(
                camera,
                r.name,
                label_state=label_states[r.name],
                golden_state=golden_states[r.name],
            )
            summary = summaries[r.name]
            features.append(
                {
                    "feature": r.name,
                    "short_name": short,
                    "owner_product": owner,
                    "shared_products": list(r.products) if r.products else None,
                    "role": r.role,
                    "classes": classes,
                    "labeled": {cls: c.get(cls, 0) for cls in classes},
                    "goldens": {cls: c.get(f"golden_{cls}", 0) for cls in classes},
                    "unlabeled": c.get("unlabeled", 0),
                    "total": c.get("total", 0),
                    "version_count": summary["count"],
                    "active_version": summary["active_number"],
                }
            )
    return {
        "camera": camera,
        "frame_count": frames,
        "feature_count": len(rois),
        "products": products,
        "features": features,
    }
