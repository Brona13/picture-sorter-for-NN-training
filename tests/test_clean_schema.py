from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import config
import db
import reset_database


class CleanSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="picture-sorter-schema-test-")
        root = Path(self.tmp.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"

    def tearDown(self) -> None:
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        self.tmp.cleanup()

    def test_schema_contains_only_direct_state_without_projection_triggers(self):
        con = db.connect()
        try:
            tables = {
                row[0]
                for row in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            triggers = con.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger'"
            ).fetchall()
            label_columns = {
                row[1] for row in con.execute("PRAGMA table_info(labels)").fetchall()
            }
            golden_columns = {
                row[1] for row in con.execute("PRAGMA table_info(goldens)").fetchall()
            }
            version = con.execute("PRAGMA user_version").fetchone()[0]
        finally:
            con.close()

        self.assertEqual(db.SCHEMA_VERSION, version)
        self.assertIn("frames", tables)
        self.assertTrue({"labels", "goldens", "deleted_frames", "dedup_mute"} <= tables)
        self.assertFalse(any(name.startswith("current_") for name in tables))
        self.assertEqual([], triggers)
        self.assertNotIn("id", label_columns)
        self.assertNotIn("action", golden_columns)
        self.assertIn("updated", label_columns)
        self.assertIn("updated", golden_columns)

    def test_incompatible_database_requires_explicit_reset(self):
        config.DATA_DIR.mkdir(parents=True)
        con = sqlite3.connect(db.db_path())
        try:
            con.execute("CREATE TABLE labels(id INTEGER PRIMARY KEY, action TEXT)")
            con.execute("PRAGMA user_version=1")
            con.commit()
        finally:
            con.close()

        with self.assertRaises(db.DatabaseResetRequired):
            db.connect()

        removed = db.reset_database()
        self.assertIn(db.db_path(), removed)
        con = db.connect()
        try:
            self.assertEqual(
                db.SCHEMA_VERSION, con.execute("PRAGMA user_version").fetchone()[0]
            )
        finally:
            con.close()

    def test_external_database_replacement_reinitializes_clean_schema(self):
        db.connect().close()
        db.db_path().unlink()

        con = db.connect()
        try:
            self.assertEqual(
                db.SCHEMA_VERSION, con.execute("PRAGMA user_version").fetchone()[0]
            )
            self.assertIsNotNone(
                con.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='frames'"
                ).fetchone()
            )
        finally:
            con.close()

    def test_reset_removes_metadata_but_preserves_sources_and_exports(self):
        camera = config.CAMERAS_ROOT / "camera"
        unsorted = camera / "unsorted"
        exports = camera / "exports"
        features = camera / "features"
        logs = camera / "logs"
        for directory in (unsorted, exports, features, logs):
            directory.mkdir(parents=True)
        (unsorted / "source.png").write_bytes(b"source")
        (exports / "dataset.zip").write_bytes(b"export")
        (features / "cutout.png").write_bytes(b"retired")
        (logs / "manifest.jsonl").write_text("{}\n", encoding="utf-8")
        (logs / "ingest_index.json").write_text("{}", encoding="utf-8")
        db.connect().close()

        reset_database.reset()

        self.assertTrue((unsorted / "source.png").exists())
        self.assertTrue((exports / "dataset.zip").exists())
        self.assertFalse(features.exists())
        self.assertFalse(logs.exists())
        self.assertFalse(db.db_path().exists())


if __name__ == "__main__":
    unittest.main()
