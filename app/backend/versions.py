"""Dataset versioning per (camera, feature): freeze / list / revert / export.

A version is a **recipe snapshot** — the labels and golden marks (with content-
hashes) at freeze time, plus counts and novelty statistics. No images are copied;
frames are immutable in ``unsorted/`` and hashes make every snapshot verifiable.
Exactly one version per (camera, feature) is *active* — the one the current
working state derives from (set on freeze, or by revert).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import datamodel
import db
import engine
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
            f"WHERE camera=? AND feature IN ({placeholders}) GROUP BY feature",
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


# --- export ------------------------------------------------------------------
def export(camera: str, feature: str, version_id: int) -> tuple[Path, dict]:
    """Materialise a version's cutouts into training-ready class folders.

    Layout: ``cameras/<cam>/exports/<feature>/v<NNN>__<name>/<class>/frame__feature.png``.
    Golden frames are exported into their class folder alongside labeled ones.
    Hashes are verified; missing/changed frames are reported, not silently skipped.
    """
    import cv2

    con = db.connect()
    try:
        v = con.execute("SELECT * FROM versions WHERE id=?", (version_id,)).fetchone()
    finally:
        con.close()
    if v is None:
        raise ValueError(f"no such version id {version_id}")

    roi = engine.resolve_roi(camera, feature)
    hmap = labels.hash_map(camera)
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in v["name"])
    # A product-scoped feature is "<product>::<roi>"; ":" is not a legal path
    # character on Windows, so it becomes "<product>-<roi>" on disk.
    safe_feature = feature.replace(datamodel.FEATURE_SEP, "-")
    dest = (
        datamodel.camera_dir(camera) / "exports" / safe_feature / f"v{v['number']:03d}__{safe}"
    )
    report = {"written": 0, "missing": [], "hash_mismatch": []}

    # A frame can be both labeled and golden for the same class — export it once.
    seen: set[tuple[str, str]] = set()
    for item in load_items(version_id):
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
        img = engine.curation.load_image(src)
        cutout = roi.crop(img)
        out_dir = dest / cls
        out_dir.mkdir(parents=True, exist_ok=True)
        ok, buf = cv2.imencode(".png", cutout)
        if ok:
            buf.tofile(str(out_dir / f"{Path(frame).stem}__{safe_feature}.png"))
            report["written"] += 1
    return dest, report
