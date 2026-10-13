from __future__ import annotations

import io
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch



import config
import datamodel
import db
import ingest
import perf


class StreamingIngestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="picture-sorter-ingest-test-")
        root = Path(self.temp_dir.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"
        self.source = root / "source"
        self.source.mkdir()
        self.camera = "camera"

    def tearDown(self) -> None:
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        self.temp_dir.cleanup()

    def test_bytes_and_file_objects_preserve_names_duplicates_and_errors(self):
        events: list[ingest.IngestProgress] = []
        result = ingest.ingest_files(
            self.camera,
            "unsorted",
            [
                ("../ strange NAME.JPG", b"first-image"),
                ("strange NAME.jpg", io.BytesIO(b"second-image")),
                ("duplicate.png", b"first-image"),
                ("empty.png", b""),
            ],
            progress_cb=events.append,
        )

        self.assertEqual(["strange_NAME.jpg", "strange_NAME_1.jpg"], result.added)
        self.assertEqual(["duplicate.png"], result.skipped)
        self.assertEqual(1, len(result.errors))
        destination = datamodel.unsorted_dir(self.camera)
        self.assertEqual(b"first-image", (destination / result.added[0]).read_bytes())
        self.assertEqual(b"second-image", (destination / result.added[1]).read_bytes())
        self.assertEqual(
            {"hashing", "copying", "duplicate", "error", "persistence"},
            {event.phase for event in events},
        )
        self.assertEqual(2, events[-1].added)
        self.assertEqual(1, events[-1].skipped)
        self.assertEqual(1, events[-1].errors)

    def test_folder_import_never_uses_read_bytes_and_second_pass_skips_duplicates(self):
        for index in range(3):
            (self.source / f"frame_{index}.png").write_bytes(
                index.to_bytes(2, "little") + b"payload"
            )
        (self.source / "ignore.txt").write_text("not an image", encoding="utf-8")

        events: list[ingest.IngestProgress] = []
        with patch.object(Path, "read_bytes", side_effect=AssertionError("not streaming")):
            first = ingest.ingest_folder(
                self.camera, "unsorted", self.source, progress_cb=events.append,
            )
            second = ingest.ingest_folder(self.camera, "unsorted", self.source)

        self.assertEqual(3, first.n_added)
        self.assertEqual(0, first.n_skipped)
        self.assertEqual(0, second.n_added)
        self.assertEqual(3, second.n_skipped)
        self.assertEqual("scanning", events[0].phase)
        self.assertEqual(3, max(event.file_total for event in events))
        self.assertEqual([], list(datamodel.unsorted_dir(self.camera).glob(".ingest-*.tmp")))

    def test_missing_source_after_scan_is_reported_and_other_files_continue(self):
        missing = self.source / "a_missing.png"
        good = self.source / "b_good.png"
        missing.write_bytes(b"will disappear")
        good.write_bytes(b"will remain")

        def remove_after_scan(update: ingest.IngestProgress) -> None:
            if update.phase == "scanning" and update.total == 2 and missing.exists():
                missing.unlink()

        result = ingest.ingest_folder(
            self.camera, "unsorted", self.source, progress_cb=remove_after_scan,
        )

        self.assertEqual(["b_good.png"], result.added)
        self.assertEqual(1, len(result.errors))
        self.assertIn("a_missing.png", result.errors[0])

    def test_frame_catalog_is_stored_in_sqlite(self):
        result = ingest.ingest_files(
            self.camera, "unsorted", [("frame.png", b"indexed-content")]
        )
        self.assertEqual(1, result.n_added)
        self.assertEqual(1, db.frame_index_count(self.camera))
        self.assertEqual(
            hashlib.sha256(b"indexed-content").hexdigest(),
            db.frame_hash_for(self.camera, "frame.png"),
        )
        self.assertFalse((config.CAMERAS_ROOT / self.camera / "logs").exists())

    def test_large_batches_checkpoint_the_catalog_before_final_completion(self):
        files = [(f"frame_{index}.png", f"payload-{index}".encode()) for index in range(26)]
        datamodel.ensure_camera_dirs(self.camera)
        with perf.trace("ingest", enabled=True, emit=False) as report:
            result = ingest.ingest_files(self.camera, "unsorted", files)

        self.assertEqual(26, result.n_added)
        self.assertEqual(26, db.frame_index_count(self.camera))
        self.assertEqual(2, report.spans["ingest.index_save"].calls)
        self.assertEqual([], list(datamodel.unsorted_dir(self.camera).glob(".ingest-*.tmp")))


if __name__ == "__main__":
    unittest.main()
