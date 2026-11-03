"""Models: a saved, named set of pinned step-2 freezes that is built into DS collection zips (plan ``plans/dataset-collection.md``,
stage 3).

A **model** has a name, the **datasets** it is built from (one pinned freeze per camera, with the dataset's folder name and OK / NG
class names and colours, in the order they are written) and the tick "include pictures without a rectangle". Pinned means a camera
that gets a newer freeze keeps its pinned one until the user changes it; the model only says that a newer one exists (``newer``).

A **build** writes the collection zip ``<data>/models/<model name>/<model name>_v001.zip`` (the number counts the builds of the
model and is never reused; DS refuses a second import of the same collection name) and records the build: the datasets as built,
the report and the **manifest**, one row per picture (camera, freeze, dataset folder, DS name, original file, app frame, hash,
class, box, size). The manifest stays in the database because DS renames pictures and ids on import. Paths of zips are kept
relative to the data folder.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from pathlib import Path

import config
import datamodel
import db
import ds_export
import model_sets


class ModelError(ValueError):
    """The request cannot be done; the message says what to change."""


class ModelNotFound(LookupError):
    """No such model, or no such build."""


NAME_MAX = 80
_UNSAFE = re.compile(r'[\\/:*?"<>|]')
DATASET_KEYS = ("camera", "version_id", "folder_name", "ok_name", "ng_name", "ok_color", "ng_color")


def folder_name(model_name: str, model_id: int | None = None) -> str:
    """The folder of a model's builds under ``<data>/models``: its name without characters a file name cannot hold."""
    safe = _UNSAFE.sub("-", model_name.strip()).strip(" .")
    return safe or (f"model-{model_id}" if model_id is not None else "model")


def models_dir() -> Path:
    return config.DATA_DIR / "models"


# --- datasets of a model -------------------------------------------------------------------------------------------------------

def _dataset(raw: dict, position: int) -> dict:
    """One dataset as stored: names and colours cleaned and defaulted (the class names default to ``<folder>-OK`` / ``<folder>-NG``,
    so datasets share a class only when the user gives them the same name)."""
    if not isinstance(raw, dict):
        raise ModelError(f"Dataset {position}: not a dataset.")
    camera = str(raw.get("camera") or "").strip()
    if not camera:
        raise ModelError(f"Dataset {position}: the camera is missing.")
    try:
        version_id = int(raw.get("version_id"))
    except (TypeError, ValueError):
        raise ModelError(f"Dataset {camera}: the freeze is missing.") from None
    folder = str(raw.get("folder_name") or "").strip() or camera
    sub = ds_export.SubFields(
        folder,
        str(raw.get("ok_name") or "").strip() or f"{folder}-OK",
        str(raw.get("ng_name") or "").strip() or f"{folder}-NG",
        str(raw.get("ok_color") or "").strip() or ds_export.DEFAULT_OK_COLOR,
        str(raw.get("ng_color") or "").strip() or ds_export.DEFAULT_NG_COLOR,
    ).cleaned(f"Dataset {folder}: ")
    return {"camera": camera, "version_id": version_id, "folder_name": sub.folder_name, "ok_name": sub.ok_name, "ng_name": sub.ng_name,
            "ok_color": sub.ok_color, "ng_color": sub.ng_color}


def _datasets(raw: list, check_freezes: bool = True) -> list[dict]:
    """The cleaned datasets. ``check_freezes``: every pinned freeze must be one a model can pin (step-2, with rectangles, not deleted)."""
    if not isinstance(raw, list):
        raise ModelError("The datasets must be a list.")
    datasets = [_dataset(r, n) for n, r in enumerate(raw, 1)]
    if not datasets:
        raise ModelError("Choose at least one dataset.")
    cameras = [d["camera"] for d in datasets]
    if len(set(cameras)) != len(cameras):
        raise ModelError("One freeze per camera: a camera appears twice.")
    ds_export.check_subs([_sub(d) for d in datasets])  # folder names differ, class names and colours are valid
    if check_freezes:
        known = set(datamodel.list_cameras())
        for d in datasets:
            if d["camera"] not in known:
                raise ModelError(f"No such camera: {d['camera']}.")
            if d["version_id"] not in {f["id"] for f in model_sets.freezes_of(d["camera"])}:
                raise ModelError(f"{d['camera']}: freeze {d['version_id']} is not a step-2 freeze with rectangles (or it was deleted).")
    return datasets


def _sub(d: dict) -> ds_export.SubFields:
    return ds_export.SubFields(d["folder_name"], d["ok_name"], d["ng_name"], d["ok_color"], d["ng_color"])


def preview(raw: list) -> dict:
    """The classes a collection of these datasets would have and the notes worth reading, without touching any freeze: the page shows
    it live while the user types names."""
    datasets = _datasets(raw, check_freezes=False)
    classes, notes = ds_export.classes_of([_sub(d) for d in datasets])
    return {"classes": classes, "notes": notes}


def _name(name: str) -> str:
    text = str(name or "").strip()
    if not text:
        raise ModelError("The model name is empty.")
    if len(text) > NAME_MAX:
        raise ModelError(f"The model name is longer than {NAME_MAX} characters.")
    return text


# --- storage ------------------------------------------------------------------------------------------------------------------

def _model_row(con: sqlite3.Connection, model_id: int) -> sqlite3.Row:
    row = con.execute("SELECT * FROM models WHERE id=?", (model_id,)).fetchone()
    if row is None:
        raise ModelNotFound(f"No such model: {model_id}.")
    return row


def _other_folder_clash(con: sqlite3.Connection, name: str, model_id: int | None) -> None:
    """Two models whose names differ only in characters a folder name cannot hold would write into one folder."""
    mine = folder_name(name).casefold()
    for row in con.execute("SELECT id, name FROM models"):
        if row["id"] != model_id and folder_name(row["name"]).casefold() == mine:
            if row["name"].casefold() == name.casefold():
                raise ModelError(f"A model named '{row['name']}' already exists.")
            raise ModelError(f"A model named '{row['name']}' already uses the folder name of '{name}'.")


def _builds_of(con: sqlite3.Connection, model_id: int) -> list[dict]:
    rows = con.execute("SELECT * FROM model_builds WHERE model_id=? ORDER BY number DESC", (model_id,)).fetchall()
    return [_build(r) for r in rows]


def _build(row: sqlite3.Row, with_report: bool = False) -> dict:
    zip_file = config.DATA_DIR / row["zip_path"]
    out = {
        "id": row["id"], "number": row["number"], "collection_name": row["collection_name"], "created": row["created"],
        "zip": row["zip_path"], "exists": zip_file.exists(), "written": row["written"],
        "include_without_box": bool(row["include_without_box"]), "datasets": json.loads(row["datasets_json"]),
    }
    if with_report:
        out["report"] = json.loads(row["report_json"])
    return out


def _dataset_state(d: dict) -> dict:
    """A dataset with what the page says about its pinned freeze: its counts and sizes, whether it is gone, and a newer freeze."""
    freezes = model_sets.freezes_of(d["camera"]) if d["camera"] in set(datamodel.list_cameras()) else []
    pinned = next((f for f in freezes if f["id"] == d["version_id"]), None)
    newest = freezes[0] if freezes else None
    out = {**d, "gone": pinned is None, "number": pinned["number"] if pinned else None, "newer": None}
    if pinned:
        out.update({k: pinned[k] for k in ("name", "created", "ok", "ng", "no_rect", "sizes", "size", "mixed")})
        if newest and newest["id"] != pinned["id"]:
            out["newer"] = {k: newest[k] for k in ("id", "number", "name", "created")}
    return out


def _model(con: sqlite3.Connection, row: sqlite3.Row, detail: bool) -> dict:
    datasets = json.loads(row["datasets_json"])
    builds = _builds_of(con, row["id"])
    out = {
        "id": row["id"], "name": row["name"], "created": row["created"], "updated": row["updated"],
        "include_without_box": bool(row["include_without_box"]), "dataset_count": len(datasets), "builds": len(builds),
        "last_build": builds[0] if builds else None, "folder": f"models/{folder_name(row['name'], row['id'])}",
    }
    if detail:
        states = [_dataset_state(d) for d in datasets]
        last = builds[0] if builds else None
        out["datasets"] = states
        out["build_list"] = builds
        # what the next build would be: the number, the collection name, and whether anything changed since the last one
        number = (last["number"] if last else 0) + 1
        out["next_build"] = {"number": number, "collection_name": ds_export.build_name(row["name"], number)}
        out["changed"] = bool(last) and (last["datasets"] != datasets or last["include_without_box"] != bool(row["include_without_box"]))
        out["stale"] = [s["camera"] for s in states if s["newer"] or s["gone"]]
        out.update(preview(datasets))  # classes and notes of the collection as it is set up now
    return out


def list_models() -> list[dict]:
    con = db.connect()
    try:
        return [_model(con, r, detail=False) for r in con.execute("SELECT * FROM models ORDER BY name COLLATE NOCASE")]
    finally:
        con.close()


def get_model(model_id: int) -> dict:
    con = db.connect()
    try:
        return _model(con, _model_row(con, model_id), detail=True)
    finally:
        con.close()


def create_model(name: str, datasets: list, include_without_box: bool = False) -> dict:
    name = _name(name)
    cleaned = _datasets(datasets)
    now = time.time()
    con = db.connect()
    try:
        _other_folder_clash(con, name, None)
        try:
            cur = con.execute(
                "INSERT INTO models(name, created, updated, include_without_box, datasets_json) VALUES (?,?,?,?,?)",
                (name, now, now, 1 if include_without_box else 0, json.dumps(cleaned)),
            )
        except sqlite3.IntegrityError:
            raise ModelError(f"A model named '{name}' already exists.") from None
        con.commit()
        return _model(con, _model_row(con, cur.lastrowid), detail=True)
    finally:
        con.close()


def update_model(model_id: int, name: str | None = None, datasets: list | None = None, include_without_box: bool | None = None) -> dict:
    """Change what is given. A new name only affects later builds: the zips already written stay where they are."""
    con = db.connect()
    try:
        row = _model_row(con, model_id)
        new_name = row["name"] if name is None else _name(name)
        new_datasets = row["datasets_json"] if datasets is None else json.dumps(_datasets(datasets))
        new_box = row["include_without_box"] if include_without_box is None else (1 if include_without_box else 0)
        _other_folder_clash(con, new_name, model_id)
        try:
            con.execute(
                "UPDATE models SET name=?, updated=?, include_without_box=?, datasets_json=? WHERE id=?",
                (new_name, time.time(), new_box, new_datasets, model_id),
            )
        except sqlite3.IntegrityError:
            raise ModelError(f"A model named '{new_name}' already exists.") from None
        con.commit()
        return _model(con, _model_row(con, model_id), detail=True)
    finally:
        con.close()


# --- builds -------------------------------------------------------------------------------------------------------------------

def build(model_id: int) -> dict:
    """Build the model's collection zip now from its pinned freezes and record the build. Every freeze is read first: when one cannot
    be (deleted, a picture missing) nothing is written and no build number is used. Returns the build with its report."""
    con = db.connect()
    try:
        row = _model_row(con, model_id)
        datasets = json.loads(row["datasets_json"])
        include = bool(row["include_without_box"])
        for d in datasets:  # a pinned freeze that was deleted since cannot be built from
            if d["version_id"] not in {f["id"] for f in model_sets.freezes_of(d["camera"])}:
                raise ModelError(f"{d['camera']}: the pinned freeze {d['version_id']} was deleted. Pick another freeze for this camera.")
        number = int(con.execute("SELECT COALESCE(MAX(number), 0) FROM model_builds WHERE model_id=?", (model_id,)).fetchone()[0]) + 1
        collection_name = ds_export.build_name(row["name"], number)
        dest = models_dir() / folder_name(row["name"], model_id) / f"{_UNSAFE.sub('-', collection_name).strip(' .')}.zip"
        entries = [ds_export.Entry(d["camera"], d["version_id"], _sub(d)) for d in datasets]
        built = ds_export.export_collection(dest, collection_name, entries, include)
        try:
            cur = con.execute(
                "INSERT INTO model_builds(model_id, number, collection_name, created, zip_path, written, include_without_box, datasets_json, report_json) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (model_id, number, collection_name, time.time(), dest.relative_to(config.DATA_DIR).as_posix(), built.report["written"],
                 1 if include else 0, row["datasets_json"], json.dumps(built.report)),
            )
            con.executemany(
                "INSERT INTO model_build_items(build_id, source_camera, version_id, dataset, name, file, frame, hash, class, ds_class, x1, y1, x2, y2, width, height) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                    (cur.lastrowid, m["camera"], m["version"], m["dataset"], m["name"], m["file"], m["frame"], m["hash"] or "", m["class"], m["ds_class"],
                     *(m["box"] if m["box"] is not None else (None, None, None, None)), m["width"], m["height"])
                    for m in built.manifest
                ],
            )
            con.commit()
        except sqlite3.IntegrityError:
            con.rollback()
            dest.unlink(missing_ok=True)
            raise ModelError("Another build of this model was made at the same time: try again.") from None
        except Exception:
            con.rollback()
            dest.unlink(missing_ok=True)
            raise
        return get_build(model_id, number)
    finally:
        con.close()


def builds(model_id: int) -> list[dict]:
    con = db.connect()
    try:
        _model_row(con, model_id)
        return _builds_of(con, model_id)
    finally:
        con.close()


def get_build(model_id: int, number: int) -> dict:
    con = db.connect()
    try:
        row = con.execute("SELECT * FROM model_builds WHERE model_id=? AND number=?", (model_id, number)).fetchone()
        if row is None:
            _model_row(con, model_id)
            raise ModelNotFound(f"Model {model_id} has no build {number}.")
        return _build(row, with_report=True)
    finally:
        con.close()


def zip_of(model_id: int, number: int) -> Path:
    """The zip of a build, or an error when it was removed from the disk."""
    path = config.DATA_DIR / get_build(model_id, number)["zip"]
    if not path.exists():
        raise ModelNotFound(f"The zip of build {number} is no longer on the disk: {path}")
    return path


def manifest(model_id: int, number: int, offset: int = 0, limit: int = 500) -> dict:
    """The pictures of a build, in the order they were written: ``{total, offset, rows}``."""
    limit = max(1, min(int(limit), 5000))
    offset = max(0, int(offset))
    con = db.connect()
    try:
        build_row = con.execute("SELECT id FROM model_builds WHERE model_id=? AND number=?", (model_id, number)).fetchone()
        if build_row is None:
            _model_row(con, model_id)
            raise ModelNotFound(f"Model {model_id} has no build {number}.")
        total = con.execute("SELECT COUNT(*) FROM model_build_items WHERE build_id=?", (build_row["id"],)).fetchone()[0]
        rows = con.execute(
            "SELECT * FROM model_build_items WHERE build_id=? ORDER BY rowid LIMIT ? OFFSET ?", (build_row["id"], limit, offset)
        ).fetchall()
    finally:
        con.close()
    return {"total": total, "offset": offset, "rows": [{
        "camera": r["source_camera"], "version": r["version_id"], "dataset": r["dataset"], "name": r["name"], "file": r["file"],
        "frame": r["frame"], "hash": r["hash"], "class": r["class"], "ds_class": r["ds_class"],
        "box": None if r["x1"] is None else [r["x1"], r["y1"], r["x2"], r["y2"]], "width": r["width"], "height": r["height"],
    } for r in rows]}
