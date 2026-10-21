"""Scoring computes no vectors for soft-deleted pictures (they are hidden everywhere but the Deleted view)."""
from __future__ import annotations

import cv2
import numpy as np

import classify
import datamodel
import db
import engine
import ingest
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase

CAM = "camD"


class DeletedFramesScoringTests(ApiTestCase):
    def test_vectors_are_not_computed_for_deleted_frames(self) -> None:
        datamodel.ensure_camera_dirs(CAM)
        rng = np.random.default_rng(1)
        names = [f"p_{i}.png" for i in range(3)]
        for n in names:
            cv2.imwrite(str(datamodel.unsorted_dir(CAM) / n), rng.integers(0, 256, (40, 60, 3), dtype=np.uint8))
        ingest.rebuild_index(CAM)
        datamodel.save_rois(CAM, [ROI("seal", 0.0, 0.0, 1.0, 1.0)])
        hmap = labels.hash_map(CAM)
        db.mark_frames_deleted(CAM, [(names[1], hmap[names[1]])])
        roi = engine.resolve_roi(CAM, "seal")
        con = db.connect()
        try:
            key = classify._roi_cache_key(roi, CAM, "seal", con)
            prepared = classify._prepare_vector_cache(con, CAM, "seal", key, roi, names, hmap, [])
        finally:
            con.close()
        self.assertEqual(prepared.kept, [names[0], names[2]])
