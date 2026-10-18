"""Authoritative current labels and golden-reference metadata in SQLite.

Version snapshots provide deliberate history. Ordinary label, golden, delete,
and mute changes overwrite current state directly instead of accumulating an
implicit event log and maintaining a duplicate projection.
"""
from __future__ import annotations

import time

import datamodel
import db
import ingest
import perf


def hash_map(camera: str) -> dict[str, str]:
    """Return filename -> content hash from the indexed SQLite frame catalog."""
    mapping = db.frame_hash_map(camera)
    if not mapping and datamodel.list_unsorted(camera):
        ingest.rebuild_index(camera)
        mapping = db.frame_hash_map(camera)
    return mapping


def frame_hash(camera: str, frame: str, hmap: dict[str, str] | None = None) -> str:
    """Return a frame hash, registering a manually added file when necessary."""
    h = hmap.get(frame) if hmap is not None else db.frame_hash_for(camera, frame)
    if h:
        return h
    path = datamodel.unsorted_dir(camera) / frame
    if not path.exists():
        return ""
    try:
        h = ingest.content_hash_file(path)
        db.record_frame(camera, frame, h, frame, path.stat().st_mtime)
        if hmap is not None:
            hmap[frame] = h
        return h
    except OSError:
        return ""


# Where a label was set, shown on the Verdict page. Callers that know the page (Dedup, Outliers, ...) pass it.
_DEFAULT_VIA = {
    "manual": "Classify",
    "bulk": "Classify bulk",
    "auto": "Classify auto-assign",
    "suggest": "Classify suggestion",
    "similar": "Find similar",
    "revert": "Versions revert",
    "golden": "Classify",
}


def _via(source: str, via: str | None) -> str:
    return (via or _DEFAULT_VIA.get(source, "")).strip()[:40]


def set_label(
    camera: str, feature: str, frame: str, cls: str, source: str = "manual", via: str | None = None
) -> None:
    """Set current label and keep an existing golden in the same class."""
    if not cls:
        clear_label(camera, feature, frame)
        return
    updated = time.time()
    h = frame_hash(camera, frame)
    con = db.connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        con.execute(
            "INSERT INTO labels(camera,feature,frame,hash,class,source,updated,via) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(camera,feature,frame) DO UPDATE SET "
            "hash=excluded.hash,class=excluded.class,source=excluded.source,"
            "updated=excluded.updated,via=excluded.via",
            (camera, feature, frame, h, cls, source, updated, _via(source, via)),
        )
        con.execute(
            "UPDATE goldens SET hash=?,class=?,updated=? "
            "WHERE camera=? AND feature=? AND frame=?",
            (h, cls, updated, camera, feature, frame),
        )
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    datamodel.invalidate_product_membership(camera)


def set_labels_bulk(
    camera: str, feature: str, frames: list[str], cls: str, source: str = "bulk", via: str | None = None
) -> int:
    if not frames:
        return 0
    if not cls:
        for frame in frames:
            clear_label(camera, feature, frame)
        return len(frames)
    updated = time.time()
    hmap = hash_map(camera)
    rows = [
        (camera, feature, frame, frame_hash(camera, frame, hmap), cls, source, updated, _via(source, via))
        for frame in frames
    ]
    con = db.connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        con.executemany(
            "INSERT INTO labels(camera,feature,frame,hash,class,source,updated,via) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(camera,feature,frame) DO UPDATE SET "
            "hash=excluded.hash,class=excluded.class,source=excluded.source,"
            "updated=excluded.updated,via=excluded.via",
            rows,
        )
        con.executemany(
            "UPDATE goldens SET hash=?,class=?,updated=? "
            "WHERE camera=? AND feature=? AND frame=?",
            [
                (h, cls, updated, camera, feature, frame)
                for _, _, frame, h, _, _, _, _ in rows
            ],
        )
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    datamodel.invalidate_product_membership(camera)
    return len(frames)


def clear_label(camera: str, feature: str, frame: str) -> None:
    """Clear label and golden atomically so the domain invariant cannot drift."""
    con = db.connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        con.execute(
            "DELETE FROM goldens WHERE camera=? AND feature=? AND frame=?",
            (camera, feature, frame),
        )
        con.execute(
            "DELETE FROM labels WHERE camera=? AND feature=? AND frame=?",
            (camera, feature, frame),
        )
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    datamodel.invalidate_product_membership(camera)


def clear_labels_bulk(camera: str, feature: str, frames: list[str]) -> int:
    """Clear labels (and any goldens) for many frames in one transaction.

    Returns how many labels were removed. A golden is always a labeled frame, so its
    golden mark goes with its label and the invariant cannot drift.
    """
    if not frames:
        return 0
    keys = [(camera, feature, frame) for frame in frames]
    con = db.connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        con.executemany(
            "DELETE FROM goldens WHERE camera=? AND feature=? AND frame=?", keys
        )
        cur = con.executemany(
            "DELETE FROM labels WHERE camera=? AND feature=? AND frame=?", keys
        )
        removed = cur.rowcount
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    datamodel.invalidate_product_membership(camera)
    return max(removed, 0)


def current_labels(camera: str, feature: str) -> dict[str, str]:
    perf.count("db.label_state.reads")
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT frame,class FROM labels WHERE camera=? AND feature=? ORDER BY frame",
            (camera, feature),
        ).fetchall()
    finally:
        con.close()
    perf.count("db.label_current.rows", len(rows))
    return {row["frame"]: row["class"] for row in rows}


def current_label_for_frame(camera: str, feature: str, frame: str) -> str | None:
    perf.count("db.label_frame_state.reads")
    con = db.connect()
    try:
        row = con.execute(
            "SELECT class FROM labels WHERE camera=? AND feature=? AND frame=?",
            (camera, feature, frame),
        ).fetchone()
    finally:
        con.close()
    perf.count("db.label_frame_current.rows", 1 if row else 0)
    return row["class"] if row else None


def mark_golden(camera: str, feature: str, frame: str, cls: str) -> None:
    """Mark a frame golden and enforce its matching label in one transaction."""
    updated = time.time()
    h = frame_hash(camera, frame)
    con = db.connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        con.execute(
            "INSERT INTO labels(camera,feature,frame,hash,class,source,updated,via) "
            "VALUES(?,?,?,?,?,'golden',?,?) ON CONFLICT(camera,feature,frame) DO UPDATE SET "
            "hash=excluded.hash,class=excluded.class,updated=excluded.updated",
            (camera, feature, frame, h, cls, updated, _via("golden", None)),
        )
        con.execute(
            "INSERT INTO goldens(camera,feature,frame,hash,class,updated) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(camera,feature,frame) DO UPDATE SET "
            "hash=excluded.hash,class=excluded.class,updated=excluded.updated",
            (camera, feature, frame, h, cls, updated),
        )
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    datamodel.invalidate_product_membership(camera)


def unmark_golden(camera: str, feature: str, frame: str, cls: str) -> None:
    con = db.connect()
    try:
        con.execute(
            "DELETE FROM goldens WHERE camera=? AND feature=? AND frame=? AND class=?",
            (camera, feature, frame, cls),
        )
        con.commit()
    finally:
        con.close()
    datamodel.invalidate_product_membership(camera)


def current_goldens(camera: str, feature: str) -> dict[str, list[str]]:
    perf.count("db.golden_state.reads")
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT frame,class FROM goldens WHERE camera=? AND feature=? "
            "ORDER BY class,frame",
            (camera, feature),
        ).fetchall()
    finally:
        con.close()
    perf.count("db.golden_current.rows", len(rows))
    output: dict[str, list[str]] = {}
    for row in rows:
        output.setdefault(row["class"], []).append(row["frame"])
    return output


def current_golden_for_frame(camera: str, feature: str, frame: str) -> str | None:
    perf.count("db.golden_frame_state.reads")
    con = db.connect()
    try:
        row = con.execute(
            "SELECT class FROM goldens WHERE camera=? AND feature=? AND frame=?",
            (camera, feature, frame),
        ).fetchone()
    finally:
        con.close()
    perf.count("db.golden_frame_current.rows", 1 if row else 0)
    return row["class"] if row else None


def current_states_for_features(
    camera: str, features: list[str]
) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, list[str]]]]:
    unique = list(dict.fromkeys(features))
    labels_by_feature = {feature: {} for feature in unique}
    goldens_by_feature = {feature: {} for feature in unique}
    if not unique:
        return labels_by_feature, goldens_by_feature
    placeholders = ",".join("?" for _ in unique)
    perf.count("db.feature_state_bulk.reads")
    con = db.connect()
    try:
        label_rows = con.execute(
            "SELECT feature,frame,class FROM labels WHERE camera=? "
            f"AND feature IN ({placeholders}) ORDER BY feature,frame",
            (camera, *unique),
        ).fetchall()
        golden_rows = con.execute(
            "SELECT feature,frame,class FROM goldens WHERE camera=? "
            f"AND feature IN ({placeholders}) ORDER BY feature,class,frame",
            (camera, *unique),
        ).fetchall()
    finally:
        con.close()
    perf.count("db.feature_label_current.rows", len(label_rows))
    perf.count("db.feature_golden_current.rows", len(golden_rows))
    for row in label_rows:
        labels_by_feature[row["feature"]][row["frame"]] = row["class"]
    for row in golden_rows:
        goldens_by_feature[row["feature"]].setdefault(row["class"], []).append(row["frame"])
    return labels_by_feature, goldens_by_feature


def golden_class_of(goldens: dict[str, list[str]], frame: str) -> str | None:
    for cls, frames in goldens.items():
        if frame in frames:
            return cls
    return None


def counts(
    camera: str,
    feature: str,
    *,
    label_state: dict[str, str] | None = None,
    golden_state: dict[str, list[str]] | None = None,
) -> dict[str, int]:
    lab = current_labels(camera, feature) if label_state is None else label_state
    gold = current_goldens(camera, feature) if golden_state is None else golden_state
    total = len(datamodel.frames_for_feature(camera, feature))
    golden_frames = {frame for frames in gold.values() for frame in frames}
    output: dict[str, int] = {}
    classes = list(
        dict.fromkeys([*datamodel.classes_for(camera, feature), *lab.values(), *gold.keys()])
    )
    for cls in classes:
        output[cls] = sum(1 for value in lab.values() if value == cls)
        output[f"golden_{cls}"] = len(gold.get(cls, []))
    output["unlabeled"] = max(0, total - len(set(lab) | golden_frames))
    output["total"] = total
    return output


def live_counts(
    camera: str,
    feature: str,
    *,
    hidden: set[str],
    label_state: dict[str, str] | None = None,
    golden_state: dict[str, list[str]] | None = None,
) -> dict[str, int]:
    """:func:`counts` for the pictures the user works with: those the ROI applies to, leaving out the ``hidden`` ones
    (deleted, and muted for this ROI). Same keys. Labels and goldens of pictures outside that set are not counted."""
    lab = current_labels(camera, feature) if label_state is None else label_state
    gold = current_goldens(camera, feature) if golden_state is None else golden_state
    live = {f for f in datamodel.frames_for_feature(camera, feature) if f not in hidden}
    lab = {f: cls for f, cls in lab.items() if f in live}
    gold = {cls: [f for f in frames if f in live] for cls, frames in gold.items()}
    golden_frames = {frame for frames in gold.values() for frame in frames}
    output: dict[str, int] = {}
    classes = list(dict.fromkeys([*datamodel.classes_for(camera, feature), *lab.values(), *gold.keys()]))
    for cls in classes:
        output[cls] = sum(1 for value in lab.values() if value == cls)
        output[f"golden_{cls}"] = len(gold.get(cls, []))
    output["unlabeled"] = max(0, len(live) - len(set(lab) | golden_frames))
    output["total"] = len(live)
    return output


def purge_feature(camera: str, feature: str) -> dict[str, int]:
    """Remove all current state, snapshots, settings, and caches for a feature."""
    con = db.connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        removed = {
            "labels": con.execute(
                "DELETE FROM labels WHERE camera=? AND feature=?", (camera, feature)
            ).rowcount,
            "goldens": con.execute(
                "DELETE FROM goldens WHERE camera=? AND feature=?", (camera, feature)
            ).rowcount,
            "cache": con.execute("DELETE FROM score_cache WHERE feature=?", (feature,)).rowcount,
            "results": con.execute(
                "DELETE FROM results_cache WHERE camera=? AND feature=?", (camera, feature)
            ).rowcount,
            "dedup_mute": con.execute(
                "DELETE FROM dedup_mute WHERE camera=? AND feature=?", (camera, feature)
            ).rowcount,
            "detections": con.execute(
                "DELETE FROM detections WHERE camera=? AND feature=?", (camera, feature)
            ).rowcount,
            "scatter": con.execute(
                "DELETE FROM scatter_cache WHERE camera=? AND feature=?", (camera, feature)
            ).rowcount,
            "cluster_snapshot": con.execute(
                "DELETE FROM cluster_snapshot WHERE camera=? AND feature=?", (camera, feature)
            ).rowcount,
        }
        removed["settings"] = con.execute(
            "DELETE FROM settings WHERE camera=? AND key IN (?,?,?,?,?)",
            (
                camera,
                f"grid.cols.{feature}",
                f"grid.perpage.{feature}",
                f"dedup.method.{feature}",
                f"dedup.epsilon.{feature}",
                f"dedup.min_points.{feature}",
            ),
        ).rowcount
        version_count = con.execute(
            "SELECT COUNT(*) FROM versions WHERE camera=? AND feature=?", (camera, feature)
        ).fetchone()[0]
        con.execute("DELETE FROM versions WHERE camera=? AND feature=?", (camera, feature))
        removed["versions"] = int(version_count)
        con.commit()
        return removed
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
