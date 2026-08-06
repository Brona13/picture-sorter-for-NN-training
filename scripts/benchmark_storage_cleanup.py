"""Compare legacy/history/file persistence with clean SQLite state tables.

All databases and JSON files are created under TemporaryDirectory. This is a
decision benchmark for the clean-break storage pass and cannot touch project
camera data.
"""

from __future__ import annotations

import json
import sqlite3
import statistics
import tempfile
import time
from pathlib import Path

from roi import ROI


EVENTS = 50_000
CURRENT_ROWS = 5_000
INDEX_ROWS = 20_000
REPETITIONS = 25


def _median_ms(function, repetitions: int = REPETITIONS):
    timings = []
    value = None
    for _ in range(repetitions):
        started = time.perf_counter()
        value = function()
        timings.append((time.perf_counter() - started) * 1_000.0)
    return statistics.median(timings), value


def _append_vs_state(root: Path) -> dict[str, object]:
    rows = [
        ("camera", "feature", f"frame-{index % CURRENT_ROWS:05d}.png", "hash", "OK", "bench", index)
        for index in range(EVENTS)
    ]
    append_path = root / "append.db"
    append = sqlite3.connect(append_path)
    append.executescript(
        """
        PRAGMA journal_mode=WAL;
        CREATE TABLE labels(
            id INTEGER PRIMARY KEY AUTOINCREMENT, camera TEXT, feature TEXT,
            frame TEXT, hash TEXT, class TEXT, source TEXT, ts REAL
        );
        CREATE TABLE current_labels(
            camera TEXT, feature TEXT, frame TEXT, hash TEXT, class TEXT,
            source TEXT, ts REAL, history_id INTEGER,
            PRIMARY KEY(camera,feature,frame)
        );
        CREATE TRIGGER sync_labels AFTER INSERT ON labels BEGIN
          INSERT INTO current_labels(camera,feature,frame,hash,class,source,ts,history_id)
          VALUES(NEW.camera,NEW.feature,NEW.frame,NEW.hash,NEW.class,NEW.source,NEW.ts,NEW.id)
          ON CONFLICT(camera,feature,frame) DO UPDATE SET
            hash=excluded.hash,class=excluded.class,source=excluded.source,
            ts=excluded.ts,history_id=excluded.history_id;
        END;
        """
    )
    started = time.perf_counter()
    append.executemany(
        "INSERT INTO labels(camera,feature,frame,hash,class,source,ts) VALUES(?,?,?,?,?,?,?)",
        rows,
    )
    append.commit()
    append_ms = (time.perf_counter() - started) * 1_000.0
    append.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    append_count = append.execute("SELECT COUNT(*) FROM current_labels").fetchone()[0]
    append.close()

    state_path = root / "state.db"
    state = sqlite3.connect(state_path)
    state.executescript(
        """
        PRAGMA journal_mode=WAL;
        CREATE TABLE labels(
            camera TEXT, feature TEXT, frame TEXT, hash TEXT, class TEXT,
            source TEXT, updated REAL,
            PRIMARY KEY(camera,feature,frame)
        );
        """
    )
    started = time.perf_counter()
    state.executemany(
        "INSERT INTO labels(camera,feature,frame,hash,class,source,updated) VALUES(?,?,?,?,?,?,?) "
        "ON CONFLICT(camera,feature,frame) DO UPDATE SET "
        "hash=excluded.hash,class=excluded.class,source=excluded.source,updated=excluded.updated",
        rows,
    )
    state.commit()
    state_ms = (time.perf_counter() - started) * 1_000.0
    state.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    state_count = state.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
    state.close()
    if append_count != state_count:
        raise RuntimeError("current-state cardinality differs")
    return {
        "events": EVENTS,
        "current_rows": CURRENT_ROWS,
        "append_trigger_ms": round(append_ms, 3),
        "direct_upsert_ms": round(state_ms, 3),
        "append_db_bytes": append_path.stat().st_size,
        "direct_state_db_bytes": state_path.stat().st_size,
    }


def _roi_file_vs_sqlite(root: Path) -> list[dict[str, object]]:
    output = []
    for count in (15, 100, 500):
        rois = [
            ROI(
                f"feature-{index}", 0.1, 0.1, 0.8, 0.8,
                role="classify" if index == 0 else "quality",
                classes=["A", "B", "C"] if index == 0 else None,
                products=["A", "B"] if index % 5 == 0 and index else None,
            )
            for index in range(count)
        ]
        json_path = root / f"rois-{count}.json"
        json_path.write_text(
            json.dumps([roi.to_dict() for roi in rois], ensure_ascii=False), encoding="utf-8"
        )
        db_path = root / f"rois-{count}.db"
        con = sqlite3.connect(db_path)
        con.execute(
            "CREATE TABLE rois(camera TEXT,name TEXT,x REAL,y REAL,w REAL,h REAL,"
            "role TEXT,classes_json TEXT,products_json TEXT,PRIMARY KEY(camera,name))"
        )
        con.executemany(
            "INSERT INTO rois VALUES(?,?,?,?,?,?,?,?,?)",
            [
                (
                    "camera", roi.name, roi.x, roi.y, roi.w, roi.h, roi.role,
                    json.dumps(roi.classes) if roi.classes else None,
                    json.dumps(roi.products) if roi.products else None,
                )
                for roi in rois
            ],
        )
        con.commit()
        con.close()

        def load_json():
            return [ROI.from_dict(item) for item in json.loads(json_path.read_text("utf-8"))]

        def load_sqlite():
            dbcon = sqlite3.connect(db_path)
            rows = dbcon.execute(
                "SELECT name,x,y,w,h,role,classes_json,products_json FROM rois "
                "WHERE camera='camera' ORDER BY rowid"
            ).fetchall()
            dbcon.close()
            return [
                ROI(
                    row[0], row[1], row[2], row[3], row[4], row[5],
                    json.loads(row[6]) if row[6] else None,
                    json.loads(row[7]) if row[7] else None,
                )
                for row in rows
            ]

        json_ms, from_json = _median_ms(load_json)
        sqlite_ms, from_sqlite = _median_ms(load_sqlite)
        if from_json != from_sqlite:
            raise RuntimeError("ROI stores produced different definitions")
        output.append(
            {
                "rois": count,
                "json_load_ms": round(json_ms, 3),
                "sqlite_load_ms": round(sqlite_ms, 3),
                "json_bytes": json_path.stat().st_size,
                "sqlite_bytes": db_path.stat().st_size,
            }
        )
    return output


def _ingest_index_file_vs_sqlite(root: Path) -> dict[str, object]:
    records = {
        f"hash-{index:064d}": {
            "folder": "unsorted",
            "filename": f"frame-{index:06d}.png",
            "orig_name": f"original-{index:06d}.png",
            "ts": float(index),
        }
        for index in range(INDEX_ROWS)
    }
    json_path = root / "ingest_index.json"
    json_path.write_text(json.dumps(records), encoding="utf-8")
    db_path = root / "frames.db"
    con = sqlite3.connect(db_path)
    con.executescript(
        "CREATE TABLE frames(camera TEXT,hash TEXT,filename TEXT,orig_name TEXT,created REAL,"
        "PRIMARY KEY(camera,filename),UNIQUE(camera,hash));"
    )
    con.executemany(
        "INSERT INTO frames VALUES('camera',?,?,?,?)",
        [(h, row["filename"], row["orig_name"], row["ts"]) for h, row in records.items()],
    )
    con.commit()
    con.close()

    json_load_ms, loaded = _median_ms(lambda: json.loads(json_path.read_text("utf-8")))
    target_name = f"frame-{INDEX_ROWS - 1:06d}.png"

    def sqlite_point():
        dbcon = sqlite3.connect(db_path)
        row = dbcon.execute(
            "SELECT hash FROM frames WHERE camera=? AND filename=?", ("camera", target_name)
        ).fetchone()
        dbcon.close()
        return row[0]

    sqlite_point_ms, point_hash = _median_ms(sqlite_point)
    expected = next(h for h, row in loaded.items() if row["filename"] == target_name)
    if point_hash != expected:
        raise RuntimeError("frame hash lookup differs")
    return {
        "rows": INDEX_ROWS,
        "json_full_load_ms": round(json_load_ms, 3),
        "sqlite_point_lookup_ms": round(sqlite_point_ms, 3),
        "json_bytes": json_path.stat().st_size,
        "sqlite_bytes": db_path.stat().st_size,
    }


def run() -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="picture-sorter-storage-") as temp_dir:
        root = Path(temp_dir)
        return {
            "append_vs_state": _append_vs_state(root),
            "roi_store": _roi_file_vs_sqlite(root),
            "ingest_index": _ingest_index_file_vs_sqlite(root),
            "storage": "TemporaryDirectory",
        }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
