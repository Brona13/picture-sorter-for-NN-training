"""Dataset versioning per (camera, feature): freeze / list / revert / export.

A version is a **recipe snapshot** — the labels and golden marks (with content-
hashes) at freeze time, plus counts and novelty statistics. No images are copied;
frames are immutable in ``unsorted/`` and hashes make every snapshot verifiable.
Exactly one version per (camera, feature) is *active* — the one the current
working state derives from (set on freeze, or by revert).

Deleting a version keeps its history row (number, name, counts, time) greyed
out and drops only its snapshot items, so version numbers are never reused.
"""
from __future__ import annotations

import datetime
import json
import math
import time
from pathlib import Path

import datamodel
import db
import labels


# --- freeze ------------------------------------------------------------------
def freeze(
    camera: str, feature: str, name: str, notes: str = "", stats: dict | None = None
) -> dict:
    """Snapshot current labels + goldens as the next version number. Returns a summary."""
    lab = labels.current_labels(camera, feature)
    gold = labels.current_goldens(camera, feature)
    hmap = labels.hash_map(camera)
    total = len(datamodel.frames_for_feature(camera, feature))
    golden_frames = {f for fr in gold.values() for f in fr}

    counts: dict[str, int] = {}
    for cls in datamodel.classes_for(camera, feature):
        counts[cls] = sum(1 for c in lab.values() if c == cls)
        counts[f"golden_{cls}"] = len(gold.get(cls, []))
    counts["unlabeled"] = max(0, total - len(set(lab) | golden_frames))
    counts["total"] = total

    con = db.connect()
    try:
        row = con.execute(
            "SELECT COALESCE(MAX(number), 0) AS n FROM versions WHERE camera=? AND feature=?",
            (camera, feature),
        ).fetchone()
        number = int(row["n"]) + 1
        con.execute(
            "UPDATE versions SET active=0 WHERE camera=? AND feature=?", (camera, feature)
        )
        cur = con.execute(
            "INSERT INTO versions(camera, feature, number, name, notes, created, "
            "counts_json, stats_json, active) VALUES (?,?,?,?,?,?,?,?,1)",
            (
                camera,
                feature,
                number,
                name.strip() or f"v{number}",
                notes.strip(),
                time.time(),
                json.dumps(counts),
                json.dumps(stats or {}),
            ),
        )
        vid = cur.lastrowid
        items = [
            (vid, f, labels.frame_hash(camera, f, hmap), "label", cls)
            for f, cls in lab.items()
        ] + [
            (vid, f, labels.frame_hash(camera, f, hmap), "golden", cls)
            for cls, frames in gold.items()
            for f in frames
        ]
        con.executemany(
            "INSERT INTO version_items(version_id, frame, hash, kind, class) VALUES (?,?,?,?,?)",
            items,
        )
        con.commit()
    finally:
        con.close()
    return {"id": vid, "number": number, "counts": counts}


# --- list / load -------------------------------------------------------------
def list_versions(camera: str, feature: str) -> list[dict]:
    """All versions, oldest first, each with a delta line vs its predecessor."""
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT * FROM versions WHERE camera=? AND feature=? ORDER BY number",
            (camera, feature),
        ).fetchall()
    finally:
        con.close()
    out: list[dict] = []
    prev_counts: dict | None = None
    for r in rows:
        counts = json.loads(r["counts_json"])
        delta = _delta_line(prev_counts, counts)
        out.append(
            {
                "id": r["id"],
                "number": r["number"],
                "name": r["name"],
                "notes": r["notes"],
                "created": r["created"],
                "counts": counts,
                "stats": json.loads(r["stats_json"]),
                "active": bool(r["active"]),
                "deleted": r["deleted"],
                "delta": delta,
            }
        )
        prev_counts = counts
    return out


def summaries(camera: str, features: list[str]) -> dict[str, dict[str, int | None]]:
    """Bulk version count and active number for multiple features."""
    unique = list(dict.fromkeys(features))
    out = {
        feature: {"count": 0, "active_number": None} for feature in unique
    }
    if not unique:
        return out
    placeholders = ",".join("?" for _ in unique)
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT feature,COUNT(*) AS version_count,"
            "MAX(CASE WHEN active=1 THEN number END) AS active_number "
            "FROM versions "
            f"WHERE camera=? AND feature IN ({placeholders}) AND deleted IS NULL "
            "GROUP BY feature",
            (camera, *unique),
        ).fetchall()
    finally:
        con.close()
    for row in rows:
        out[row["feature"]] = {
            "count": int(row["version_count"]),
            "active_number": (
                int(row["active_number"])
                if row["active_number"] is not None
                else None
            ),
        }
    return out


def _delta_line(prev: dict | None, cur: dict) -> str:
    if prev is None:
        return "first version"
    parts = []
    for key in cur:
        d = cur.get(key, 0) - prev.get(key, 0)
        if d and key not in ("total", "unlabeled"):
            parts.append(f"{'+' if d > 0 else ''}{d} {key.replace('golden_', 'golden ')}")
    return ", ".join(parts) if parts else "no changes"


def load_items(version_id: int) -> list[dict]:
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT frame, hash, kind, class FROM version_items WHERE version_id=?",
            (version_id,),
        ).fetchall()
    finally:
        con.close()
    return [dict(r) for r in rows]


# --- revert ------------------------------------------------------------------
def revert(camera: str, feature: str, version_id: int) -> dict:
    """Replace working labels and goldens with a snapshot and mark it active."""
    items = load_items(version_id)
    snap_labels = {i["frame"]: i["class"] for i in items if i["kind"] == "label"}
    snap_gold: dict[str, set] = {}
    for i in items:
        if i["kind"] == "golden":
            snap_gold.setdefault(i["class"], set()).add(i["frame"])

    cur_labels = labels.current_labels(camera, feature)
    cur_gold = labels.current_goldens(camera, feature)

    for frame in set(cur_labels) - set(snap_labels):
        labels.clear_label(camera, feature, frame)
    for frame, cls in snap_labels.items():
        if cur_labels.get(frame) != cls:
            labels.set_label(camera, feature, frame, cls, source="revert")

    for cls in set(cur_gold) | set(snap_gold):
        now, want = set(cur_gold.get(cls, [])), snap_gold.get(cls, set())
        for frame in now - want:
            labels.unmark_golden(camera, feature, frame, cls)
        for frame in want - now:
            labels.mark_golden(camera, feature, frame, cls)

    con = db.connect()
    try:
        con.execute("UPDATE versions SET active=0 WHERE camera=? AND feature=?", (camera, feature))
        con.execute("UPDATE versions SET active=1 WHERE id=?", (version_id,))
        con.commit()
    finally:
        con.close()
    return {"labels": len(snap_labels), "goldens": sum(len(v) for v in snap_gold.values())}


# --- delete ------------------------------------------------------------------
class ActiveVersionError(ValueError):
    """The active version cannot be deleted."""


class AlreadyDeletedError(ValueError):
    """The version was deleted before."""


def delete_version(camera: str, feature: str, version_id: int) -> None:
    """Delete a saved (non-active) version's snapshot; keep its history row.

    The row stays (marked deleted) so numbers are never reused and the history
    explains gaps such as v1 and v3 on disk with v2 gone. Working labels/goldens
    are untouched and files already exported are not removed.
    """
    con = db.connect()
    try:
        row = con.execute(
            "SELECT active, deleted FROM versions WHERE id=? AND camera=? AND feature=?",
            (version_id, camera, feature),
        ).fetchone()
        if row is None:
            raise ValueError(f"no such version id {version_id}")
        if row["deleted"] is not None:
            raise AlreadyDeletedError("this version is already deleted")
        if row["active"]:
            raise ActiveVersionError("the active version cannot be deleted")
        con.execute("DELETE FROM version_items WHERE version_id=?", (version_id,))
        con.execute("UPDATE versions SET deleted=? WHERE id=?", (time.time(), version_id))
        con.commit()
    finally:
        con.close()


# --- export ------------------------------------------------------------------
def export(camera: str, feature: str, version_id: int) -> tuple[Path, dict]:
    """Copy a version's golden frames, untouched, into class folders.

    Layout: ``cameras/<cam>/exports/<feature>/v<NNN>__<name>/<class>/<original filename>``.
    Only golden frames are exported; other labeled frames exist for scoring and
    stay in the snapshot only. No cutouts and no manifest: the original filename
    is kept so labels in other tools map back to the source frame.
    Hashes are verified; missing/changed frames are reported, not silently skipped.
    """
    import shutil

    con = db.connect()
    try:
        v = con.execute("SELECT * FROM versions WHERE id=?", (version_id,)).fetchone()
    finally:
        con.close()
    if v is None:
        raise ValueError(f"no such version id {version_id}")

    hmap = labels.hash_map(camera)
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in v["name"])
    # A product-scoped feature is "<product>::<roi>"; ":" is not a legal path
    # character on Windows, so it becomes "<product>-<roi>" on disk.
    safe_feature = feature.replace(datamodel.FEATURE_SEP, "-")
    dest = (
        datamodel.camera_dir(camera) / "exports" / safe_feature / f"v{v['number']:03d}__{safe}"
    )
    report = {"written": 0, "missing": [], "hash_mismatch": []}

    # Goldens only. A golden is always labeled, so its snapshot also holds a label
    # item; skipping kind="label" exports each golden once.
    seen: set[tuple[str, str]] = set()
    for item in load_items(version_id):
        if item["kind"] != "golden":
            continue
        frame, cls = item["frame"], item["class"]
        if (frame, cls) in seen:
            continue
        seen.add((frame, cls))
        src = datamodel.unsorted_dir(camera) / frame
        if not src.exists():
            report["missing"].append(frame)
            continue
        if item["hash"] and labels.frame_hash(camera, frame, hmap) != item["hash"]:
            report["hash_mismatch"].append(frame)
            continue
        out_dir = dest / cls
        out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, out_dir / Path(frame).name)
        report["written"] += 1
    return dest, report


# --- downstream results ------------------------------------------------------
# Quality values measured by the training/inspection system on a dataset exported from a version.
# This app never computes them; it only records them so curation choices can be traced to outcomes.
RESULT_NAME_MAX = 80
RESULT_NOTE_MAX = 500


class ResultError(ValueError):
    """A recorded result that is malformed or refers to nothing."""


def _clean_result(name, value, note, measured) -> tuple[str, float, str, str]:
    name = " ".join(str(name or "").split())
    if not name:
        raise ResultError("A result needs a metric name")
    if len(name) > RESULT_NAME_MAX:
        raise ResultError(f"The metric name is limited to {RESULT_NAME_MAX} characters")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ResultError("The value must be a number")
    note = str(note or "").strip()
    if len(note) > RESULT_NOTE_MAX:
        raise ResultError(f"The note is limited to {RESULT_NOTE_MAX} characters")
    day = measured or datetime.date.today().isoformat()
    try:
        day = datetime.date.fromisoformat(str(day)).isoformat()
    except ValueError as exc:
        raise ResultError("The date must look like 2026-10-15") from exc
    return name, float(value), note, day


def _result_row(r) -> dict:
    return {
        "id": r["id"],
        "version_id": r["version_id"],
        "name": r["name"],
        "value": r["value"],
        "note": r["note"],
        "measured": r["measured"],
        "created": r["created"],
    }


def results_by_version(camera: str, feature: str) -> dict[int, list[dict]]:
    """Every recorded result of the feature's versions, newest measurement first, by version id."""
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT r.* FROM version_results r JOIN versions v ON v.id = r.version_id "
            "WHERE v.camera=? AND v.feature=? ORDER BY r.measured DESC, r.created DESC, r.id DESC",
            (camera, feature),
        ).fetchall()
    finally:
        con.close()
    out: dict[int, list[dict]] = {}
    for r in rows:
        out.setdefault(r["version_id"], []).append(_result_row(r))
    return out


def add_result(camera: str, feature: str, version_id: int, name, value, note="", measured=None) -> dict:
    """Record a downstream value against a version of this feature (also a deleted one: history stays)."""
    name, value, note, day = _clean_result(name, value, note, measured)
    con = db.connect()
    try:
        owner = con.execute("SELECT 1 FROM versions WHERE id=? AND camera=? AND feature=?", (version_id, camera, feature)).fetchone()
        if owner is None:
            raise ResultError(f"no such version id {version_id}")
        cur = con.execute(
            "INSERT INTO version_results(version_id, name, value, note, measured, created) VALUES (?,?,?,?,?,?)",
            (version_id, name, value, note, day, time.time()),
        )
        con.commit()
        row = con.execute("SELECT * FROM version_results WHERE id=?", (cur.lastrowid,)).fetchone()
    finally:
        con.close()
    return _result_row(row)


def _owned_result(con, camera: str, feature: str, result_id: int, version_id: int | None = None):
    row = con.execute(
        "SELECT r.* FROM version_results r JOIN versions v ON v.id = r.version_id "
        "WHERE r.id=? AND v.camera=? AND v.feature=?",
        (result_id, camera, feature),
    ).fetchone()
    return row if row is not None and version_id in (None, row["version_id"]) else None


def update_result(camera: str, feature: str, result_id: int, name, value, note="", measured=None, version_id: int | None = None) -> dict:
    """Correct a recorded result; the version it belongs to cannot change."""
    name, value, note, day = _clean_result(name, value, note, measured)
    con = db.connect()
    try:
        if _owned_result(con, camera, feature, result_id, version_id) is None:
            raise ResultError(f"no such result id {result_id}")
        con.execute("UPDATE version_results SET name=?, value=?, note=?, measured=? WHERE id=?", (name, value, note, day, result_id))
        con.commit()
        row = con.execute("SELECT * FROM version_results WHERE id=?", (result_id,)).fetchone()
    finally:
        con.close()
    return _result_row(row)


def delete_result(camera: str, feature: str, result_id: int, version_id: int | None = None) -> None:
    con = db.connect()
    try:
        if _owned_result(con, camera, feature, result_id, version_id) is None:
            raise ResultError(f"no such result id {result_id}")
        con.execute("DELETE FROM version_results WHERE id=?", (result_id,))
        con.commit()
    finally:
        con.close()
