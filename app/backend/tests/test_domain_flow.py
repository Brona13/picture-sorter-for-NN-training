from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np



import classify
import config
import datamodel
import db
import ingest
import labels
import versions
from roi import ROI


class EndToEndFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="picture-sorter-e2e-")
        root = Path(self.tmp.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        self.old_embedding = config.EMBEDDING_ENABLED
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"
        config.EMBEDDING_ENABLED = False
        self.source = root / "incoming"
        self.source.mkdir()
        self.camera = "flow-camera"
        self.feature = "inspection"

    def tearDown(self) -> None:
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        config.EMBEDDING_ENABLED = self.old_embedding
        self.tmp.cleanup()

    def _create_source_images(self, count: int = 10) -> None:
        yy, xx = np.mgrid[:72, :96]
        for index in range(count):
            base = (xx * 3 + yy * 5 + index * 19) % 256
            image = np.stack(
                [base, (base + index * 11) % 256, 255 - base], axis=2
            ).astype(np.uint8)
            cv2.rectangle(image, (18, 14), (78, 58), (20, 180, 240), 2)
            self.assertTrue(cv2.imwrite(str(self.source / f"frame-{index:02d}.png"), image))

    def test_complete_domain_flow(self) -> None:
        # Camera creation and streamed ingest establish the clean schema and frame catalog.
        datamodel.ensure_camera_dirs(self.camera)
        self._create_source_images()
        ingest_events: list[ingest.IngestProgress] = []
        ingested = ingest.ingest_folder(
            self.camera, self.source, progress_cb=ingest_events.append
        )
        self.assertEqual(10, ingested.n_added)
        self.assertEqual(10, db.frame_index_count(self.camera))
        self.assertEqual("persistence", ingest_events[-1].phase)

        con = db.connect()
        try:
            tables = {
                row[0]
                for row in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            self.assertEqual(db.SCHEMA_VERSION, con.execute("PRAGMA user_version").fetchone()[0])
        finally:
            con.close()
        self.assertTrue({"frames", "labels", "goldens", "versions"} <= tables)

        # ROI creation, labels, and goldens exercise both sides of their invariant.
        datamodel.save_rois(
            self.camera, [ROI(self.feature, 0.12, 0.10, 0.76, 0.80)]
        )
        frames = [path.name for path in datamodel.list_unsorted(self.camera)]
        expected_labels = {
            frame: "OK" if index % 2 == 0 else "NG"
            for index, frame in enumerate(frames)
        }
        for frame, cls in expected_labels.items():
            labels.set_label(self.camera, self.feature, frame, cls, source="e2e")
        labels.mark_golden(self.camera, self.feature, frames[0], "OK")
        labels.mark_golden(self.camera, self.feature, frames[1], "NG")
        self.assertEqual(expected_labels, labels.current_labels(self.camera, self.feature))
        self.assertEqual(
            {"OK": [frames[0]], "NG": [frames[1]]},
            labels.current_goldens(self.camera, self.feature),
        )

        # Current deletion and dedup-mute sets support reversible state changes.
        frame_hashes = labels.hash_map(self.camera)
        db.mark_frames_deleted(
            self.camera, [(frames[-1], frame_hashes[frames[-1]])], source="e2e"
        )
        self.assertTrue(db.is_frame_deleted(self.camera, frames[-1]))
        self.assertEqual(1, db.restore_frames(self.camera, [frames[-1]]))
        db.add_dedup_mutes(
            self.camera,
            self.feature,
            [(frames[-2], frame_hashes[frames[-2]], 1)],
            source="e2e",
        )
        self.assertEqual({frames[-2]}, db.muted_frames(self.camera, self.feature))
        self.assertEqual(1, db.add_dedup_unmutes(self.camera, self.feature, [frames[-2]]))

        # Classical scoring builds vectors, compares candidates, and returns all frames.
        score_events: list[classify.ScoringProgress] = []
        results = classify.refresh(
            self.camera, self.feature, phase_progress_cb=score_events.append
        )
        self.assertEqual(len(frames), len(results))
        self.assertTrue(any(result.per_method.get("cpu") for result in results if not result.golden))
        self.assertEqual("comparison", score_events[-1].phase)

        # Freeze, mutate, revert, and project export prove the explicit history path end to end.
        frozen = versions.freeze(self.camera, self.feature, "baseline", notes="e2e")
        labels.set_label(self.camera, self.feature, frames[2], "NG", source="e2e-change")
        labels.clear_label(self.camera, self.feature, frames[3])
        versions.revert(self.camera, self.feature, frozen["id"])
        self.assertEqual(expected_labels, labels.current_labels(self.camera, self.feature))
        self.assertEqual(
            {"OK": [frames[0]], "NG": [frames[1]]},
            labels.current_goldens(self.camera, self.feature),
        )
        # Export is done from project (verdict) versions: the two labelled frames carry OK / NG verdicts.
        project = versions.freeze_project(self.camera, "verdicts")
        destination, export_report = versions.export(self.camera, project["id"])
        self.assertEqual(len(expected_labels), export_report["written"])
        self.assertEqual([], export_report["missing"])
        self.assertEqual([], export_report["hash_mismatch"])
        self.assertEqual(len(expected_labels), len(list(destination.rglob("*.png"))))


if __name__ == "__main__":
    unittest.main()
