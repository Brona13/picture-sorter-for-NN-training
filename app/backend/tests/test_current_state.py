from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path



import config
import db
import labels
import perf


class DirectCurrentStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"
        self.camera = "camera"
        self.feature = "feature"
        self.frame = "frame.png"

    def tearDown(self):
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        self.tmp.cleanup()

    def _insert_label(self, cls: str) -> None:
        labels.set_label(self.camera, self.feature, self.frame, cls, source="test")

    def _insert_golden(self, cls: str, action: str) -> None:
        if action == "add":
            labels.mark_golden(self.camera, self.feature, self.frame, cls)
        else:
            labels.unmark_golden(self.camera, self.feature, self.frame, cls)

    def test_latest_label_matches_bulk_state(self):
        self._insert_label("OK")
        self._insert_label("NG")
        self.assertEqual(
            "NG", labels.current_label_for_frame(self.camera, self.feature, self.frame)
        )
        self.assertEqual(
            labels.current_labels(self.camera, self.feature).get(self.frame),
            labels.current_label_for_frame(self.camera, self.feature, self.frame),
        )

        labels.clear_label(self.camera, self.feature, self.frame)
        self.assertIsNone(
            labels.current_label_for_frame(self.camera, self.feature, self.frame)
        )

        con = db.connect()
        try:
            self.assertEqual(0, con.execute("SELECT COUNT(*) FROM labels").fetchone()[0])
        finally:
            con.close()

    def test_latest_golden_action_matches_bulk_state(self):
        self._insert_golden("OK", "add")
        self.assertEqual(
            "OK", labels.current_golden_for_frame(self.camera, self.feature, self.frame)
        )
        self._insert_golden("OK", "remove")
        self.assertIsNone(
            labels.current_golden_for_frame(self.camera, self.feature, self.frame)
        )
        self._insert_golden("NG", "add")
        bulk = labels.current_goldens(self.camera, self.feature)
        self.assertEqual(
            labels.golden_class_of(bulk, self.frame),
            labels.current_golden_for_frame(self.camera, self.feature, self.frame),
        )

    def test_golden_and_label_are_one_consistent_state(self):
        labels.mark_golden(self.camera, self.feature, self.frame, "OK")
        self.assertEqual(
            "OK", labels.current_label_for_frame(self.camera, self.feature, self.frame)
        )

        labels.set_label(self.camera, self.feature, self.frame, "NG")
        self.assertEqual(
            "NG", labels.current_golden_for_frame(self.camera, self.feature, self.frame)
        )

        labels.clear_label(self.camera, self.feature, self.frame)
        self.assertIsNone(
            labels.current_golden_for_frame(self.camera, self.feature, self.frame)
        )

    def test_latest_delete_action(self):
        self.assertFalse(db.is_frame_deleted(self.camera, self.frame))
        db.mark_frames_deleted(self.camera, [(self.frame, "hash")], source="test")
        self.assertTrue(db.is_frame_deleted(self.camera, self.frame))
        db.restore_frames(self.camera, [self.frame], source="test")
        self.assertFalse(db.is_frame_deleted(self.camera, self.frame))

    def test_targeted_reads_report_one_direct_state_row(self):
        for cls in ("OK", "NG", "OK", "NG"):
            self._insert_label(cls)
        with perf.trace("targeted", enabled=True, emit=False) as report:
            self.assertEqual(
                "NG", labels.current_label_for_frame(self.camera, self.feature, self.frame)
            )
        self.assertEqual(1, report.counters["db.label_frame_current.rows"])
        con = db.connect()
        try:
            self.assertEqual(1, con.execute("SELECT COUNT(*) FROM labels").fetchone()[0])
        finally:
            con.close()


if __name__ == "__main__":
    unittest.main()
