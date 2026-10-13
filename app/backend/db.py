"""SQLite persistence for current curation state, snapshots, and caches.

Images and ROI geometry remain filesystem data. Everything that benefits from
indexed lookup or transactional updates lives in one SQLite database. State
tables are authoritative current values; deliberate dataset history is captured
through explicit Versions rather than implicit append-only event logs.
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import config
import perf


SCHEMA_VERSION = 2


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

CREATE TABLE IF NOT EXISTS labels (
    camera  TEXT NOT NULL,
    feature TEXT NOT NULL,
    frame   TEXT NOT NULL,
    hash    TEXT NOT NULL DEFAULT '',
    class   TEXT NOT NULL,
    source  TEXT NOT NULL DEFAULT 'manual',
    updated REAL NOT NULL,
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
    """Open a short-lived connection, creating only the clean schema."""
    perf.count("db.connections")
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    version = int(con.execute("PRAGMA user_version").fetchone()[0])
    if version != SCHEMA_VERSION:
        if version != 0 or _has_user_tables(con):
            con.close()
            raise DatabaseResetRequired(
                f"Database schema {version} is incompatible with clean schema "
                f"{SCHEMA_VERSION}. Run `python app/backend/reset_database.py --yes` "
                "to remove metadata and caches; source images and rois.json are kept."
            )
        with perf.span("db.schema.initialize"):
            con.executescript(_SCHEMA)
    return con


def reset_database() -> list[Path]:
    """Remove the exact SQLite database and sidecars; source images are untouched."""
    path = db_path()
    removed: list[Path] = []
    for candidate in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        if candidate.exists():
            candidate.unlink()
            removed.append(candidate)
    return removed


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
    camera: str, entries: list[tuple[str, str]], source: str = "user"
) -> int:
    if not entries:
        return 0
    updated = time.time()
    con = connect()
    try:
        con.executemany(
            "INSERT INTO deleted_frames(camera,frame,hash,source,updated) VALUES(?,?,?,?,?) "
            "ON CONFLICT(camera,frame) DO UPDATE SET hash=excluded.hash,"
            "source=excluded.source,updated=excluded.updated",
            [(camera, frame, h, source, updated) for frame, h in entries],
        )
        con.commit()
        return len(entries)
    finally:
        con.close()


def restore_frames(camera: str, frames: list[str], source: str = "user") -> int:
    del source
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


def add_dedup_unmutes(
    camera: str, feature: str, frames: list[str], source: str = "dedup"
) -> int:
    del source
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
