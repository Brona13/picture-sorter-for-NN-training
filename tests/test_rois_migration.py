"""Migration coverage for schema v2 → v3 (JSON ROIs → ``rois`` table)."""
from __future__ import annotations

import json
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


# The pre-v3 schema, minus the ``rois`` table. Enough to make user_version=2
# a plausible "old real database" for the migration to encounter.
_V2_SCHEMA = """
CREATE TABLE frames (
    camera    TEXT NOT NULL,
    filename  TEXT NOT NULL,
    hash      TEXT NOT NULL,
    orig_name TEXT NOT NULL,
    created   REAL NOT NULL,
    PRIMARY KEY (camera, filename),
    UNIQUE (camera, hash)
);
CREATE TABLE labels (
    camera  TEXT NOT NULL,
    feature TEXT NOT NULL,
    frame   TEXT NOT NULL,
    hash    TEXT NOT NULL DEFAULT '',
    class   TEXT NOT NULL,
    source  TEXT NOT NULL DEFAULT 'manual',
    updated REAL NOT NULL,
    PRIMARY KEY (camera, feature, frame)
);
PRAGMA user_version = 2;
"""


def _seed_v2_database() -> None:
    db.db_path().parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db.db_path())
    try:
        con.executescript(_V2_SCHEMA)
        con.commit()
    finally:
        con.close()


def _seed_roi_json(camera: str, rois: list[dict]) -> Path:
    camera_dir = config.CAMERAS_ROOT / camera
    camera_dir.mkdir(parents=True, exist_ok=True)
    path = camera_dir / "rois.json"
    path.write_text(json.dumps(rois), encoding="utf-8")
    return path


class MigrationV2ToV3Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="rois-migration-test-")
        root = Path(self.tmp.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"

    def tearDown(self) -> None:
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        self.tmp.cleanup()

    def _fetch_rois(self, camera: str) -> list[sqlite3.Row]:
        con = db.connect()
        try:
            return con.execute(
                "SELECT name, x, y, w, h, role, classes_json, products_json, position "
                "FROM rois WHERE camera=? ORDER BY position",
                (camera,),
            ).fetchall()
        finally:
            con.close()

    def test_backfills_multiple_cameras_and_deletes_json_files(self) -> None:
        cam3_rois = [
            {
                "name": "product",
                "x": 0.35, "y": 0.37, "w": 0.31, "h": 0.16,
                "role": "classify",
                "classes": ["2x4", "4x4", "4x4RS"],
            }
        ]
        cam4_rois = [
            {"name": "rod-bottom-left", "x": 0.25, "y": 0.48, "w": 0.09, "h": 0.10},
            {"name": "rod-top-right", "x": 0.66, "y": 0.23, "w": 0.07, "h": 0.08},
        ]
        cam3_path = _seed_roi_json("pekat-cam3", cam3_rois)
        cam4_path = _seed_roi_json("pekat-cam4", cam4_rois)
        _seed_v2_database()

        # First connect() runs the migration; assertions run on a fresh
        # connection so we're reading committed state.
        db.connect().close()

        self.assertFalse(cam3_path.exists(), "cam3 rois.json should be deleted")
        self.assertFalse(cam4_path.exists(), "cam4 rois.json should be deleted")

        rows3 = self._fetch_rois("pekat-cam3")
        self.assertEqual(1, len(rows3))
        self.assertEqual("product", rows3[0]["name"])
        self.assertEqual("classify", rows3[0]["role"])
        self.assertEqual(["2x4", "4x4", "4x4RS"], json.loads(rows3[0]["classes_json"]))
        self.assertIsNone(rows3[0]["products_json"])
        self.assertEqual(0, rows3[0]["position"])

        rows4 = self._fetch_rois("pekat-cam4")
        self.assertEqual(["rod-bottom-left", "rod-top-right"], [r["name"] for r in rows4])
        # Position preserves the original JSON array order.
        self.assertEqual([0, 1], [r["position"] for r in rows4])
        # Default role survives round-trip.
        self.assertTrue(all(r["role"] == "quality" for r in rows4))

    def test_migration_bumps_user_version(self) -> None:
        _seed_v2_database()
        con = db.connect()
        try:
            self.assertEqual(
                db.SCHEMA_VERSION,
                con.execute("PRAGMA user_version").fetchone()[0],
            )
        finally:
            con.close()

    def test_migration_is_a_noop_second_time(self) -> None:
        path = _seed_roi_json("cam", [{"name": "r", "x": 0, "y": 0, "w": 1, "h": 1}])
        _seed_v2_database()
        db.connect().close()  # runs migration
        self.assertFalse(path.exists())
        # A second connect() sees user_version=3 and takes the fast path.
        con = db.connect()
        try:
            rows = con.execute("SELECT name FROM rois WHERE camera=?", ("cam",)).fetchall()
        finally:
            con.close()
        self.assertEqual(["r"], [r["name"] for r in rows])

    def test_malformed_json_is_skipped_and_file_kept(self) -> None:
        camera_dir = config.CAMERAS_ROOT / "corrupt-cam"
        camera_dir.mkdir(parents=True)
        bad = camera_dir / "rois.json"
        bad.write_text("this is not JSON", encoding="utf-8")
        good_path = _seed_roi_json(
            "good-cam", [{"name": "r", "x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5}]
        )
        _seed_v2_database()

        db.connect().close()

        # Corrupt file preserved for the user to inspect; good file consumed.
        self.assertTrue(bad.exists())
        self.assertFalse(good_path.exists())
        # DB has the good ROI and no rows for the corrupt camera.
        con = db.connect()
        try:
            corrupt = con.execute(
                "SELECT COUNT(*) FROM rois WHERE camera=?", ("corrupt-cam",)
            ).fetchone()[0]
            good = con.execute(
                "SELECT COUNT(*) FROM rois WHERE camera=?", ("good-cam",)
            ).fetchone()[0]
        finally:
            con.close()
        self.assertEqual(0, corrupt)
        self.assertEqual(1, good)

    def test_no_json_files_still_migrates_cleanly(self) -> None:
        # v2 DB, cameras/ exists but no rois.json anywhere.
        (config.CAMERAS_ROOT / "empty-cam").mkdir(parents=True)
        _seed_v2_database()
        db.connect().close()
        con = db.connect()
        try:
            count = con.execute("SELECT COUNT(*) FROM rois").fetchone()[0]
            self.assertEqual(0, count)
        finally:
            con.close()

    def test_unmigratable_version_still_requires_explicit_reset(self) -> None:
        # v1 (or any version we don't know how to migrate from) must not
        # silently succeed — the user is told to reset.
        db.db_path().parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(db.db_path())
        try:
            con.executescript(
                "CREATE TABLE labels(id INTEGER PRIMARY KEY, action TEXT);"
                "PRAGMA user_version = 1;"
            )
            con.commit()
        finally:
            con.close()

        with self.assertRaises(db.DatabaseResetRequired):
            db.connect()


if __name__ == "__main__":
    unittest.main()
