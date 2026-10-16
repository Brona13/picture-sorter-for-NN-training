"""SQLite persistence for current curation state, snapshots, and caches.

Images and ROI geometry remain filesystem data. Everything that benefits from
indexed lookup or transactional updates lives in one SQLite database. State
tables are authoritative current values; deliberate dataset history is captured
through explicit Versions rather than implicit append-only event logs.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

import config
import perf


SCHEMA_VERSION = 8


class DatabaseResetRequired(RuntimeError):
    """Raised when an older incompatible database must be reset explicitly."""


_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS frames (
    camera    TEXT NOT NULL,
    filename  TEXT NOT NULL,
    hash      TEXT NOT NULL,
    orig_name TEXT NOT NULL,
    created   REAL NOT NULL,
    PRIMARY KEY (camera, filename),
    UNIQUE (camera, hash)
);
CREATE INDEX IF NOT EXISTS idx_frames_hash ON frames(camera, hash);

CREATE TABLE IF NOT EXISTS rois (
    camera        TEXT NOT NULL,
    name          TEXT NOT NULL,
    x             REAL NOT NULL,
    y             REAL NOT NULL,
    w             REAL NOT NULL,
    h             REAL NOT NULL,
    role          TEXT NOT NULL DEFAULT 'quality',
    classes_json  TEXT,
    products_json TEXT,
    position      INTEGER NOT NULL,
    updated       REAL NOT NULL,
    PRIMARY KEY (camera, name)
);
CREATE INDEX IF NOT EXISTS idx_rois_camera_position ON rois(camera, position);

CREATE TABLE IF NOT EXISTS labels (
    camera  TEXT NOT NULL,
    feature TEXT NOT NULL,
    frame   TEXT NOT NULL,
    hash    TEXT NOT NULL DEFAULT '',
    class   TEXT NOT NULL,
    source  TEXT NOT NULL DEFAULT 'manual',
    updated REAL NOT NULL,
    via     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (camera, feature, frame)
);
CREATE INDEX IF NOT EXISTS idx_labels_feature ON labels(camera, feature, class);

CREATE TABLE IF NOT EXISTS goldens (
    camera  TEXT NOT NULL,
    feature TEXT NOT NULL,
    frame   TEXT NOT NULL,
    hash    TEXT NOT NULL DEFAULT '',
    class   TEXT NOT NULL,
    updated REAL NOT NULL,
    PRIMARY KEY (camera, feature, frame)
);
CREATE INDEX IF NOT EXISTS idx_goldens_feature ON goldens(camera, feature, class);

CREATE TABLE IF NOT EXISTS deleted_frames (
    camera  TEXT NOT NULL,
    frame   TEXT NOT NULL,
    hash    TEXT NOT NULL DEFAULT '',
    source  TEXT NOT NULL DEFAULT 'user',
    updated REAL NOT NULL,
    note    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (camera, frame)
);

CREATE TABLE IF NOT EXISTS dedup_mute (
    camera     TEXT NOT NULL,
    feature    TEXT NOT NULL,
    frame      TEXT NOT NULL,
    hash       TEXT NOT NULL DEFAULT '',
    cluster_id INTEGER NOT NULL,
    source     TEXT NOT NULL DEFAULT 'dedup',
    updated    REAL NOT NULL,
    PRIMARY KEY (camera, feature, frame)
);
CREATE INDEX IF NOT EXISTS idx_dedup_mute_feature ON dedup_mute(camera, feature);

CREATE TABLE IF NOT EXISTS score_cache (
    hash    TEXT NOT NULL,
    feature TEXT NOT NULL,
    roi_key TEXT NOT NULL,
    kind    TEXT NOT NULL,
    vec     BLOB NOT NULL,
    ts      REAL NOT NULL,
    PRIMARY KEY (hash, feature, roi_key, kind)
);

CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    camera      TEXT NOT NULL,
    feature     TEXT NOT NULL,
    number      INTEGER NOT NULL,
    name        TEXT NOT NULL,
    notes       TEXT NOT NULL DEFAULT '',
    created     REAL NOT NULL,
    counts_json TEXT NOT NULL DEFAULT '{{}}',
    stats_json  TEXT NOT NULL DEFAULT '{{}}',
    active      INTEGER NOT NULL DEFAULT 0,
    deleted     REAL,
    UNIQUE (camera, feature, number)
);
CREATE INDEX IF NOT EXISTS idx_versions_lookup ON versions(camera, feature, number);

CREATE TABLE IF NOT EXISTS version_items (
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    frame      TEXT NOT NULL,
    hash       TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL,
    class      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_version_items ON version_items(version_id);

CREATE TABLE IF NOT EXISTS version_results (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    value      REAL NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    measured   TEXT NOT NULL,
    created    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_version_results ON version_results(version_id);

CREATE TABLE IF NOT EXISTS verdict_decisions (
    camera     TEXT NOT NULL,
    frame      TEXT NOT NULL,
    hash       TEXT NOT NULL DEFAULT '',
    class      TEXT NOT NULL,
    inputs_sig TEXT NOT NULL,
    updated    REAL NOT NULL,
    PRIMARY KEY (camera, frame)
);

CREATE TABLE IF NOT EXISTS settings (
    camera TEXT NOT NULL,
    key    TEXT NOT NULL,
    value  TEXT NOT NULL,
    PRIMARY KEY (camera, key)
);

CREATE TABLE IF NOT EXISTS cluster_snapshot (
    camera  TEXT NOT NULL,
    feature TEXT NOT NULL,
    payload BLOB NOT NULL,
    ts      REAL NOT NULL,
    PRIMARY KEY (camera, feature)
);

CREATE TABLE IF NOT EXISTS scatter_cache (
    camera     TEXT NOT NULL,
    feature    TEXT NOT NULL,
    method     TEXT NOT NULL,
    backbone   TEXT NOT NULL,
    frames_sig TEXT NOT NULL,
    payload    BLOB NOT NULL,
    ts         REAL NOT NULL,
    PRIMARY KEY (camera, feature, method, backbone)
);

CREATE TABLE IF NOT EXISTS results_cache (
    camera     TEXT NOT NULL,
    feature    TEXT NOT NULL,
    roi_key    TEXT NOT NULL,
    golden_sig TEXT NOT NULL,
    frames_sig TEXT NOT NULL,
    payload    BLOB NOT NULL,
    ts         REAL NOT NULL,
    PRIMARY KEY (camera, feature, roi_key)
);

CREATE TABLE IF NOT EXISTS detections (
    camera  TEXT NOT NULL,
    feature TEXT NOT NULL,
    hash    TEXT NOT NULL,
    rank    INTEGER NOT NULL,
    x       REAL NOT NULL,
    y       REAL NOT NULL,
    w       REAL NOT NULL,
    h       REAL NOT NULL,
    conf    REAL NOT NULL,
    status  TEXT NOT NULL,
    sig     TEXT NOT NULL DEFAULT '',
    ts      REAL NOT NULL,
    PRIMARY KEY (camera, feature, hash, rank)
);

PRAGMA user_version = {SCHEMA_VERSION};
"""


def db_path() -> Path:
    return config.DATA_DIR / "picture_sorter.db"


def _has_user_tables(con: sqlite3.Connection) -> bool:
    return bool(
        con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' LIMIT 1"
        ).fetchone()
    )


def connect() -> sqlite3.Connection:
    """Open a short-lived connection, creating or upgrading the schema in place."""
    perf.count("db.connections")
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    version = int(con.execute("PRAGMA user_version").fetchone()[0])
    if version == SCHEMA_VERSION:
        return con
    # The UI fires several requests at once; without this lock they all try to
    # create/upgrade the schema together and fail with "database is locked".
    with _schema_lock:
        try:
            _bring_schema_current(con)
        except Exception:
            con.close()
            raise
    return con


_schema_lock = threading.Lock()


def _bring_schema_current(con: sqlite3.Connection) -> None:
    """Create or upgrade the schema; call with ``_schema_lock`` held."""
    # Another thread may have finished the upgrade while this one waited.
    version = int(con.execute("PRAGMA user_version").fetchone()[0])
    if version == SCHEMA_VERSION:
        return
    if version == 0 and not _has_user_tables(con):
        with perf.span("db.schema.initialize"):
            con.executescript(_SCHEMA)
        return
    while version in _MIGRATIONS and version < SCHEMA_VERSION:
        with perf.span(f"db.schema.migrate_v{version}_v{version + 1}"):
            _MIGRATIONS[version](con)
        version = int(con.execute("PRAGMA user_version").fetchone()[0])
    if version != SCHEMA_VERSION:
        raise DatabaseResetRequired(
            f"Database schema {version} is incompatible with clean schema "
            f"{SCHEMA_VERSION} and no forward migration is defined. "
            "Run `python app/backend/reset_database.py --yes` to remove metadata and "
            "caches; source images are kept."
        )


# --- schema migrations ------------------------------------------------------
def _migrate_v2_to_v3(con: sqlite3.Connection) -> None:
    """Add the ``rois`` table and backfill it from every ``cameras/<camera>/rois.json``.

    All DB writes (schema, rows, user_version bump) run inside one explicit
    ``BEGIN…COMMIT`` — a partial failure rolls the whole thing back and
    leaves ``user_version`` at 2 with the JSON files intact. Corrupt or
    malformed JSON is skipped (its file stays on disk for inspection). The
    source JSONs are unlinked **after** commit so we never end up with
    rolled-back DB rows but deleted files on disk.
    """
    to_delete: list[Path] = []
    con.execute("BEGIN")
    try:
        con.execute(
            "CREATE TABLE IF NOT EXISTS rois ("
            "camera TEXT NOT NULL, name TEXT NOT NULL, "
            "x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, "
            "role TEXT NOT NULL DEFAULT 'quality', "
            "classes_json TEXT, products_json TEXT, "
            "position INTEGER NOT NULL, updated REAL NOT NULL, "
            "PRIMARY KEY (camera, name))"
        )
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_rois_camera_position "
            "ON rois(camera, position)"
        )
        now = time.time()
        root = config.CAMERAS_ROOT
        if root.exists():
            for camera_dir in sorted(p for p in root.iterdir() if p.is_dir()):
                json_path = camera_dir / "rois.json"
                if not json_path.is_file():
                    continue
                try:
                    data = json.loads(json_path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    continue  # leave the file for the user to inspect
                if not isinstance(data, list):
                    continue
                camera = camera_dir.name
                for position, entry in enumerate(data):
                    if not isinstance(entry, dict) or "name" not in entry:
                        continue
                    classes = entry.get("classes") or None
                    products = entry.get("products") or None
                    con.execute(
                        "INSERT OR REPLACE INTO rois "
                        "(camera, name, x, y, w, h, role, classes_json, "
                        "products_json, position, updated) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            camera,
                            str(entry["name"]),
                            float(entry.get("x", 0.0)),
                            float(entry.get("y", 0.0)),
                            float(entry.get("w", 1.0)),
                            float(entry.get("h", 1.0)),
                            str(entry.get("role", "quality")),
                            json.dumps(list(classes)) if classes else None,
                            json.dumps(list(products)) if products else None,
                            position,
                            now,
                        ),
                    )
                to_delete.append(json_path)
        con.execute("PRAGMA user_version = 3")
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    for path in to_delete:
        try:
            path.unlink()
        except OSError:
            perf.count("db.migrate_v2_v3.json_unlink_failed")


def _migrate_v3_to_v4(con: sqlite3.Connection) -> None:
    """Add ``versions.deleted`` (NULL, or the time a version was deleted).

    Deleted versions stay as greyed-out history rows so their numbers are never
    reused. A database without a ``versions`` table is only re-stamped.
    """
    con.execute("BEGIN IMMEDIATE")  # write lock first, so a second process waits and re-checks
    try:
        columns = {row[1] for row in con.execute("PRAGMA table_info(versions)").fetchall()}
        if columns and "deleted" not in columns:
            con.execute("ALTER TABLE versions ADD COLUMN deleted REAL")
        con.execute("PRAGMA user_version = 4")
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def _migrate_v4_to_v5(con: sqlite3.Connection) -> None:
    """Add ``detections``: per-frame object boxes (auto, reviewed or manual) per feature."""
    con.execute("BEGIN IMMEDIATE")  # write lock first, so a second process waits and re-checks
    try:
        con.execute(
            "CREATE TABLE IF NOT EXISTS detections ("
            "camera TEXT NOT NULL, feature TEXT NOT NULL, hash TEXT NOT NULL, "
            "rank INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, "
            "h REAL NOT NULL, conf REAL NOT NULL, status TEXT NOT NULL, "
            "sig TEXT NOT NULL DEFAULT '', ts REAL NOT NULL, "
            "PRIMARY KEY (camera, feature, hash, rank))"
        )
        con.execute("PRAGMA user_version = 5")
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def _migrate_v5_to_v6(con: sqlite3.Connection) -> None:
    """Add ``deleted_frames.note``: an optional reason typed when a frame is deleted."""
    con.execute("BEGIN IMMEDIATE")
    try:
        columns = {row[1] for row in con.execute("PRAGMA table_info(deleted_frames)")}
        if columns and "note" not in columns:
            con.execute("ALTER TABLE deleted_frames ADD COLUMN note TEXT NOT NULL DEFAULT ''")
        con.execute("PRAGMA user_version = 6")
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def _migrate_v6_to_v7(con: sqlite3.Connection) -> None:
    """Add ``version_results``: downstream quality values recorded against a version."""
    con.execute("BEGIN IMMEDIATE")
    try:
        con.execute(
            "CREATE TABLE IF NOT EXISTS version_results ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE, "
            "name TEXT NOT NULL, value REAL NOT NULL, note TEXT NOT NULL DEFAULT '', "
            "measured TEXT NOT NULL, created REAL NOT NULL)"
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_version_results ON version_results(version_id)")
        con.execute("PRAGMA user_version = 7")
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def _migrate_v7_to_v8(con: sqlite3.Connection) -> None:
    """Add ``labels.via`` (the page a label was set on) and ``verdict_decisions`` (the user's own verdicts)."""
    con.execute("BEGIN IMMEDIATE")
    try:
        columns = {row[1] for row in con.execute("PRAGMA table_info(labels)")}
        if columns and "via" not in columns:
            con.execute("ALTER TABLE labels ADD COLUMN via TEXT NOT NULL DEFAULT ''")
        con.execute(
            "CREATE TABLE IF NOT EXISTS verdict_decisions ("
            "camera TEXT NOT NULL, frame TEXT NOT NULL, hash TEXT NOT NULL DEFAULT '', "
            "class TEXT NOT NULL, inputs_sig TEXT NOT NULL, updated REAL NOT NULL, "
            "PRIMARY KEY (camera, frame))"
        )
        con.execute("PRAGMA user_version = 8")
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


_MIGRATIONS = {
    2: _migrate_v2_to_v3,
    3: _migrate_v3_to_v4,
    4: _migrate_v4_to_v5,
    5: _migrate_v5_to_v6,
    6: _migrate_v6_to_v7,
    7: _migrate_v7_to_v8,
}


def reset_database() -> list[Path]:
    """Remove the exact SQLite database and sidecars; source images are untouched."""
    path = db_path()
    removed: list[Path] = []
    for candidate in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        if candidate.exists():
            candidate.unlink()
            removed.append(candidate)
    return removed


# --- ROIs --------------------------------------------------------------------
def list_rois(camera: str) -> list[dict]:
    """Return every ROI defined for ``camera`` in UI order (by ``position``).

    Each row is a plain dict with keys ``name, x, y, w, h, role, classes,
    products`` — the JSON columns are decoded to Python lists (or ``None``).
    """
    con = connect()
    try:
        rows = con.execute(
            "SELECT name, x, y, w, h, role, classes_json, products_json "
            "FROM rois WHERE camera=? ORDER BY position",
            (camera,),
        ).fetchall()
    finally:
        con.close()
    return [_row_to_roi_dict(row) for row in rows]


def get_roi_row(camera: str, name: str) -> dict | None:
    """Return one ROI dict, or ``None`` if it doesn't exist."""
    con = connect()
    try:
        row = con.execute(
            "SELECT name, x, y, w, h, role, classes_json, products_json "
            "FROM rois WHERE camera=? AND name=?",
            (camera, name),
        ).fetchone()
    finally:
        con.close()
    return _row_to_roi_dict(row) if row else None


def replace_rois(camera: str, entries: list[dict]) -> None:
    """Atomically replace every ROI for ``camera`` with ``entries``.

    ``entries`` is a list of ROI dicts (as returned by :func:`list_rois`);
    their positions come from the list index so callers control ordering
    by passing them in the desired UI order.
    """
    now = time.time()
    con = connect()
    try:
        con.execute("BEGIN")
        try:
            con.execute("DELETE FROM rois WHERE camera=?", (camera,))
            for position, entry in enumerate(entries):
                classes = entry.get("classes") or None
                products = entry.get("products") or None
                con.execute(
                    "INSERT INTO rois "
                    "(camera, name, x, y, w, h, role, classes_json, "
                    "products_json, position, updated) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        camera,
                        str(entry["name"]),
                        float(entry["x"]),
                        float(entry["y"]),
                        float(entry["w"]),
                        float(entry["h"]),
                        str(entry.get("role", "quality")),
                        json.dumps(list(classes)) if classes else None,
                        json.dumps(list(products)) if products else None,
                        position,
                        now,
                    ),
                )
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
    finally:
        con.close()


def delete_roi_row(camera: str, name: str) -> bool:
    """Remove one ROI; return True if a row was actually deleted."""
    con = connect()
    try:
        count = con.execute(
            "DELETE FROM rois WHERE camera=? AND name=?", (camera, name)
        ).rowcount
        con.commit()
        return count > 0
    finally:
        con.close()


def _row_to_roi_dict(row: sqlite3.Row) -> dict:
    classes = json.loads(row["classes_json"]) if row["classes_json"] else None
    products = json.loads(row["products_json"]) if row["products_json"] else None
    return {
        "name": row["name"],
        "x": row["x"], "y": row["y"], "w": row["w"], "h": row["h"],
        "role": row["role"],
        "classes": classes,
        "products": products,
    }


# --- frame/content index -----------------------------------------------------
def frame_index_count(camera: str) -> int:
    con = connect()
    try:
        return int(
            con.execute("SELECT COUNT(*) FROM frames WHERE camera=?", (camera,)).fetchone()[0]
        )
    finally:
        con.close()


def frame_hash_map(camera: str) -> dict[str, str]:
    con = connect()
    try:
        rows = con.execute(
            "SELECT filename,hash FROM frames WHERE camera=?", (camera,)
        ).fetchall()
        return {row["filename"]: row["hash"] for row in rows}
    finally:
        con.close()


def frame_hash_for(camera: str, filename: str) -> str | None:
    con = connect()
    try:
        row = con.execute(
            "SELECT hash FROM frames WHERE camera=? AND filename=?", (camera, filename)
        ).fetchone()
        return row["hash"] if row else None
    finally:
        con.close()


def record_frame(
    camera: str,
    filename: str,
    content_hash: str,
    orig_name: str | None = None,
    created: float | None = None,
) -> None:
    con = connect()
    try:
        con.execute(
            "INSERT INTO frames(camera,filename,hash,orig_name,created) VALUES(?,?,?,?,?) "
            "ON CONFLICT(camera,filename) DO UPDATE SET hash=excluded.hash,"
            "orig_name=excluded.orig_name,created=excluded.created",
            (camera, filename, content_hash, orig_name or filename, created or time.time()),
        )
        con.commit()
    finally:
        con.close()


def replace_frame_index(camera: str, records: list[tuple[str, str, str, float]]) -> None:
    """Replace one camera's frame index. Records are hash, filename, original, created."""
    con = connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        con.execute("DELETE FROM frames WHERE camera=?", (camera,))
        con.executemany(
            "INSERT INTO frames(camera,hash,filename,orig_name,created) VALUES(?,?,?,?,?)",
            [(camera, h, filename, original, created) for h, filename, original, created in records],
        )
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


# --- settings ---------------------------------------------------------------
def get_setting(camera: str, key: str, default: str | None = None) -> str | None:
    perf.count("db.settings.reads")
    con = connect()
    try:
        row = con.execute(
            "SELECT value FROM settings WHERE camera=? AND key=?", (camera, key)
        ).fetchone()
        return row["value"] if row else default
    finally:
        con.close()


def set_setting(camera: str, key: str, value: str) -> None:
    con = connect()
    try:
        con.execute(
            "INSERT INTO settings(camera,key,value) VALUES(?,?,?) "
            "ON CONFLICT(camera,key) DO UPDATE SET value=excluded.value",
            (camera, key, value),
        )
        con.commit()
    finally:
        con.close()


# --- scored result cache ----------------------------------------------------
def load_results(camera: str, feature: str, roi_key: str) -> dict | None:
    perf.count("db.results_cache.reads")
    con = connect()
    try:
        row = con.execute(
            "SELECT golden_sig,frames_sig,payload FROM results_cache "
            "WHERE camera=? AND feature=? AND roi_key=?",
            (camera, feature, roi_key),
        ).fetchone()
    finally:
        con.close()
    if row is None:
        return None
    return {
        "golden_sig": row["golden_sig"],
        "frames_sig": row["frames_sig"],
        "payload": bytes(row["payload"]),
    }


def results_signatures(camera: str, feature: str, roi_key: str) -> tuple[str, str] | None:
    """``(golden_sig, frames_sig)`` of the stored scored results without loading the payload."""
    con = connect()
    try:
        row = con.execute(
            "SELECT golden_sig,frames_sig FROM results_cache WHERE camera=? AND feature=? AND roi_key=?",
            (camera, feature, roi_key),
        ).fetchone()
    finally:
        con.close()
    return None if row is None else (row["golden_sig"], row["frames_sig"])


def save_results(
    camera: str,
    feature: str,
    roi_key: str,
    golden_sig: str,
    frames_sig: str,
    payload: bytes,
) -> None:
    perf.count("db.results_cache.writes")
    con = connect()
    try:
        con.execute(
            "INSERT INTO results_cache(camera,feature,roi_key,golden_sig,frames_sig,payload,ts) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(camera,feature,roi_key) DO UPDATE SET "
            "golden_sig=excluded.golden_sig,frames_sig=excluded.frames_sig,"
            "payload=excluded.payload,ts=excluded.ts",
            (camera, feature, roi_key, golden_sig, frames_sig, payload, time.time()),
        )
        con.commit()
    finally:
        con.close()


def delete_results(camera: str, feature: str) -> int:
    con = connect()
    try:
        count = con.execute(
            "DELETE FROM results_cache WHERE camera=? AND feature=?", (camera, feature)
        ).rowcount
        con.commit()
        return count
    finally:
        con.close()


# --- dedup/scatter derived snapshots ---------------------------------------
def save_cluster_snapshot(camera: str, feature: str, payload: bytes) -> None:
    con = connect()
    try:
        con.execute(
            "INSERT INTO cluster_snapshot(camera,feature,payload,ts) VALUES(?,?,?,?) "
            "ON CONFLICT(camera,feature) DO UPDATE SET payload=excluded.payload,ts=excluded.ts",
            (camera, feature, payload, time.time()),
        )
        con.commit()
    finally:
        con.close()


def load_cluster_snapshot(camera: str, feature: str) -> bytes | None:
    con = connect()
    try:
        row = con.execute(
            "SELECT payload FROM cluster_snapshot WHERE camera=? AND feature=?",
            (camera, feature),
        ).fetchone()
        return bytes(row["payload"]) if row else None
    finally:
        con.close()


def load_scatter(camera: str, feature: str, method: str, backbone: str) -> dict | None:
    con = connect()
    try:
        row = con.execute(
            "SELECT frames_sig,payload FROM scatter_cache "
            "WHERE camera=? AND feature=? AND method=? AND backbone=?",
            (camera, feature, method, backbone),
        ).fetchone()
    finally:
        con.close()
    return (
        {"frames_sig": row["frames_sig"], "payload": bytes(row["payload"])}
        if row
        else None
    )


def save_scatter(
    camera: str,
    feature: str,
    method: str,
    backbone: str,
    frames_sig: str,
    payload: bytes,
) -> None:
    con = connect()
    try:
        con.execute(
            "INSERT INTO scatter_cache(camera,feature,method,backbone,frames_sig,payload,ts) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(camera,feature,method,backbone) DO UPDATE SET "
            "frames_sig=excluded.frames_sig,payload=excluded.payload,ts=excluded.ts",
            (camera, feature, method, backbone, frames_sig, payload, time.time()),
        )
        con.commit()
    finally:
        con.close()


# --- camera-wide soft deletion ---------------------------------------------
def mark_frames_deleted(
    camera: str, entries: list[tuple[str, str]], source: str = "user", note: str = ""
) -> int:
    if not entries:
        return 0
    updated = time.time()
    con = connect()
    try:
        con.executemany(
            "INSERT INTO deleted_frames(camera,frame,hash,source,updated,note) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(camera,frame) DO UPDATE SET hash=excluded.hash,"
            "source=excluded.source,updated=excluded.updated,note=excluded.note",
            [(camera, frame, h, source, updated, note) for frame, h in entries],
        )
        con.commit()
        return len(entries)
    finally:
        con.close()


def restore_frames(camera: str, frames: list[str]) -> int:
    if not frames:
        return 0
    placeholders = ",".join("?" for _ in frames)
    con = connect()
    try:
        count = con.execute(
            f"DELETE FROM deleted_frames WHERE camera=? AND frame IN ({placeholders})",
            (camera, *frames),
        ).rowcount
        con.commit()
        return count
    finally:
        con.close()


def deleted_frames_of(camera: str) -> set[str]:
    perf.count("db.deleted_state.reads")
    con = connect()
    try:
        rows = con.execute(
            "SELECT frame FROM deleted_frames WHERE camera=? ORDER BY frame", (camera,)
        ).fetchall()
    finally:
        con.close()
    perf.count("db.deleted_current.rows", len(rows))
    return {row["frame"] for row in rows}


def deleted_frames_info(camera: str) -> list[dict]:
    """Deleted frames with deletion time (epoch seconds) and note, newest first."""
    con = connect()
    try:
        rows = con.execute(
            "SELECT frame,updated,note FROM deleted_frames WHERE camera=? "
            "ORDER BY updated DESC, frame",
            (camera,),
        ).fetchall()
    finally:
        con.close()
    return [{"frame": r["frame"], "deleted_at": r["updated"], "note": r["note"]} for r in rows]


def set_deleted_note(camera: str, frame: str, note: str) -> bool:
    """Change the note of an already-deleted frame; the deletion time stays."""
    con = connect()
    try:
        count = con.execute(
            "UPDATE deleted_frames SET note=? WHERE camera=? AND frame=?", (note, camera, frame)
        ).rowcount
        con.commit()
        return count > 0
    finally:
        con.close()


def is_frame_deleted(camera: str, frame: str) -> bool:
    perf.count("db.deleted_frame_state.reads")
    con = connect()
    try:
        row = con.execute(
            "SELECT 1 FROM deleted_frames WHERE camera=? AND frame=?", (camera, frame)
        ).fetchone()
    finally:
        con.close()
    perf.count("db.deleted_frame_current.rows", 1 if row else 0)
    return row is not None


# --- feature-scoped dedup mutes --------------------------------------------
def add_dedup_mutes(
    camera: str,
    feature: str,
    entries: list[tuple[str, str, int]],
    source: str = "dedup",
) -> int:
    if not entries:
        return 0
    updated = time.time()
    con = connect()
    try:
        con.executemany(
            "INSERT INTO dedup_mute(camera,feature,frame,hash,cluster_id,source,updated) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(camera,feature,frame) DO UPDATE SET "
            "hash=excluded.hash,cluster_id=excluded.cluster_id,source=excluded.source,"
            "updated=excluded.updated",
            [
                (camera, feature, frame, h, cluster_id, source, updated)
                for frame, h, cluster_id in entries
            ],
        )
        con.commit()
        return len(entries)
    finally:
        con.close()


def add_dedup_unmutes(camera: str, feature: str, frames: list[str]) -> int:
    if not frames:
        return 0
    placeholders = ",".join("?" for _ in frames)
    con = connect()
    try:
        count = con.execute(
            f"DELETE FROM dedup_mute WHERE camera=? AND feature=? "
            f"AND frame IN ({placeholders})",
            (camera, feature, *frames),
        ).rowcount
        con.commit()
        return count
    finally:
        con.close()


def clear_dedup_mutes(camera: str, feature: str) -> int:
    con = connect()
    try:
        count = con.execute(
            "DELETE FROM dedup_mute WHERE camera=? AND feature=?", (camera, feature)
        ).rowcount
        con.commit()
        return count
    finally:
        con.close()


def muted_frames(camera: str, feature: str) -> set[str]:
    perf.count("db.muted_state.reads")
    con = connect()
    try:
        rows = con.execute(
            "SELECT frame FROM dedup_mute WHERE camera=? AND feature=? ORDER BY frame",
            (camera, feature),
        ).fetchall()
    finally:
        con.close()
    perf.count("db.mute_current.rows", len(rows))
    return {row["frame"] for row in rows}
