from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import config
import datamodel
import db
import ingest
import labels
import perf
import versions
from roi import ROI


class RenderSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"
        self.camera = "camera"
        datamodel.ensure_camera_dirs(self.camera)

    def tearDown(self):
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        self.tmp.cleanup()

    def test_repeated_reads_use_one_physical_snapshot(self):
        (datamodel.unsorted_dir(self.camera) / "a.png").write_bytes(b"a")
        datamodel.save_rois(self.camera, [ROI.full_frame("feature")])

        with perf.trace("snapshot", enabled=True, emit=False) as report:
            with datamodel.render_snapshot():
                self.assertEqual(datamodel.list_unsorted(self.camera), datamodel.list_unsorted(self.camera))
                self.assertEqual(datamodel.load_rois(self.camera), datamodel.load_rois(self.camera))

        self.assertEqual(1, report.counters["filesystem.unsorted_scans"])
        self.assertEqual(1, report.counters["roi.file_reads"])
        self.assertEqual(2, report.counters["render_snapshot.hits"])

    def test_ingest_and_roi_save_invalidate_active_snapshot(self):
        datamodel.save_rois(self.camera, [ROI.full_frame("old")])
        with datamodel.render_snapshot():
            self.assertEqual([], datamodel.list_unsorted(self.camera))
            self.assertEqual(["old"], [r.name for r in datamodel.load_rois(self.camera)])

            result = ingest.ingest_files(
                self.camera, [("new.png", b"synthetic-image-bytes")]
            )
            self.assertEqual(1, result.n_added)
            self.assertEqual(["new.png"], [p.name for p in datamodel.list_unsorted(self.camera)])

            datamodel.save_rois(self.camera, [ROI.full_frame("new")])
            self.assertEqual(["new"], [r.name for r in datamodel.load_rois(self.camera)])

    def test_product_label_change_invalidates_membership(self):
        for name in ("a.png", "b.png"):
            (datamodel.unsorted_dir(self.camera) / name).write_bytes(name.encode())
        datamodel.save_rois(
            self.camera,
            [ROI("product-sort", 0, 0, 1, 1, role="classify", classes=["A", "B"])],
        )

        with datamodel.render_snapshot():
            self.assertEqual([], datamodel.frames_of_product(self.camera, "A"))
            labels.set_label(self.camera, "product-sort", "a.png", "A")
            self.assertEqual(["a.png"], datamodel.frames_of_product(self.camera, "A"))

    def test_bulk_summaries_match_individual_helpers(self):
        features = ["one", "two"]
        con = db.connect()
        try:
            con.executemany(
                "INSERT INTO labels(camera,feature,frame,hash,class,source,updated) "
                "VALUES (?,?,?,?,?,'test',0)",
                [
                    (self.camera, "one", "a.png", "", "OK"),
                    (self.camera, "two", "b.png", "", "NG"),
                ],
            )
            con.execute(
                "INSERT INTO goldens(camera,feature,frame,hash,class,updated) "
                "VALUES (?,?,?,?,?,0)",
                (self.camera, "one", "a.png", "", "OK"),
            )
            con.executemany(
                "INSERT INTO versions(camera,feature,number,name,created,active) "
                "VALUES (?,?,?,? ,0,?)",
                [
                    (self.camera, "one", 1, "v1", 0),
                    (self.camera, "one", 2, "v2", 1),
                    (self.camera, "two", 1, "v1", 1),
                ],
            )
            con.commit()
        finally:
            con.close()

        label_states, golden_states = labels.current_states_for_features(
            self.camera, features
        )
        for feature in features:
            self.assertEqual(
                labels.current_labels(self.camera, feature), label_states[feature]
            )
            self.assertEqual(
                labels.current_goldens(self.camera, feature), golden_states[feature]
            )
        self.assertEqual(
            {
                "one": {"count": 2, "active_number": 2},
                "two": {"count": 1, "active_number": 1},
            },
            versions.summaries(self.camera, features),
        )

        labels.set_label(self.camera, "two", "b.png", "OK")
        labels.mark_golden(self.camera, "two", "b.png", "OK")
        updated_labels, updated_goldens = labels.current_states_for_features(
            self.camera, features
        )
        self.assertEqual("OK", updated_labels["two"]["b.png"])
        self.assertEqual(["b.png"], updated_goldens["two"]["OK"])


if __name__ == "__main__":
    unittest.main()
