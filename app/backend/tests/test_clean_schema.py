from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path



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


class MigrationV3ToV4Tests(unittest.TestCase):
    """versions.deleted is added in place and keeps existing version rows."""

    def setUp(self) -> None:
        import sqlite3
        import tempfile
        from pathlib import Path

        self.tmp = tempfile.TemporaryDirectory(prefix="v3-v4-")
        self.old = (config.CAMERAS_ROOT, config.DATA_DIR)
        config.CAMERAS_ROOT = Path(self.tmp.name) / "cameras"
        config.DATA_DIR = Path(self.tmp.name) / "data"
        db.db_path().parent.mkdir(parents=True)
        con = sqlite3.connect(db.db_path())
        con.executescript(
            "CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, camera TEXT NOT NULL, "
            "feature TEXT NOT NULL, number INTEGER NOT NULL, name TEXT NOT NULL, "
            "notes TEXT NOT NULL DEFAULT '', created REAL NOT NULL, "
            "counts_json TEXT NOT NULL DEFAULT '{}', stats_json TEXT NOT NULL DEFAULT '{}', "
            "active INTEGER NOT NULL DEFAULT 0, UNIQUE (camera, feature, number));"
            "INSERT INTO versions(camera,feature,number,name,created,active) VALUES ('c','f',1,'keep',0,1);"
            "PRAGMA user_version = 3;"
        )
        con.commit()
        con.close()

    def tearDown(self) -> None:
        config.CAMERAS_ROOT, config.DATA_DIR = self.old
        self.tmp.cleanup()

    def test_adds_deleted_column_and_keeps_rows(self) -> None:
        con = db.connect()
        try:
            columns = {r[1] for r in con.execute("PRAGMA table_info(versions)").fetchall()}
            row = con.execute("SELECT name, deleted FROM versions").fetchone()
            version = con.execute("PRAGMA user_version").fetchone()[0]
        finally:
            con.close()
        self.assertIn("deleted", columns)
        self.assertEqual((row["name"], row["deleted"]), ("keep", None))
        self.assertEqual(version, db.SCHEMA_VERSION)

    def test_parallel_first_connects_all_succeed(self) -> None:
        """The UI fires several requests at once on startup; each opens the old DB."""
        import threading

        n = 12
        barrier = threading.Barrier(n)
        errors: list[BaseException] = []

        def worker() -> None:
            try:
                barrier.wait()
                db.connect().close()
            except BaseException as exc:  # noqa: BLE001 - report any failure
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual([], [repr(e) for e in errors])

    def test_parallel_first_connects_on_empty_database(self) -> None:
        import threading

        db.db_path().unlink()  # start from no database at all
        n = 12
        barrier = threading.Barrier(n)
        errors: list[BaseException] = []

        def worker() -> None:
            try:
                barrier.wait()
                db.connect().close()
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual([], [repr(e) for e in errors])
