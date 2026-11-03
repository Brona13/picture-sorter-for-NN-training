"""The import zip of the downstream system (DS) made from a frozen step-2 Export (v1.150.0).

DS imports a zip with ``datasetCollection.json`` and one folder of pictures side by side at the zip root. The JSON lists the
classes (``ObjectDetectionLabelDefinitions``) and one sub-dataset with its pictures and their boxes. The format was read from
real DS exports (``plans`` / handover ``ds-json-writer-handover.md``); what is written here is exactly what was seen there:

- picture ``Name`` is the original file name without extension, the file in the folder is ``<Name><extension>``;
- a box is absolute pixels, top-left origin, upright, the last pixel is ``width - 1`` / ``height - 1`` (DS counts the pixel
  indices, the Box numbers of this app are edges with an exclusive end, so the end is written minus one and clamped);
- a picture without boxes is listed with an empty list;
- ``FolderPath`` is DS-internal (DS ignores it on import); ids are free, DS renumbers them.

The pure functions (``select``, ``ds_box``, ``build_collection``) know nothing of the database; ``export`` reads a frozen
project version and writes ``exports/project/<zip name>.zip``.

A **dataset collection** (v1.153.0, plan ``plans/dataset-collection.md`` stage 2) holds several sub-datasets, one per camera: each
is the frozen step-2 Export of that camera (``collect``), with its own folder name and OK / NG class names and colours
(``SubFields``). Classes with equal names (ignoring case) are one class with one id and one colour (``classes_of``); ids of
datasets and classes are generated and unique (DS renumbers them). ``build_multi`` is the pure part, ``export_collection``
reads the freezes, copies the original pictures byte for byte and returns a manifest of what went into the zip.
"""
from __future__ import annotations

import json
import os
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

import datamodel
import db
import ds_assets
import labels
import samples
import versions

DEFAULT_OK_COLOR = "#06e52b"  # RGB(6, 229, 43), the green of a real DS export
DEFAULT_NG_COLOR = "#f44336"  # RGB(244, 67, 54), the red of a real DS export
DATASET_ID, OK_ID, NG_ID = 1, 2, 3  # DS renumbers all ids on import
IMAGE_TYPE, IMAGE_STORAGE, LABEL_SCOPE = 17, 2, 1
FOLDER_PATH = f"ObjectDetectionArchiveDatasetImages/{DATASET_ID}"
FIRST_CLASS_ID = 101  # class ids of a collection start here; dataset ids are 1, 2, 3, ...
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


SETTING = "ds.export"  # per camera: {"fields": last values, "versions": {version id: {"zip", "written"}}}


class DsExportError(ValueError):
    """The export cannot be made; the message says what to change."""


@dataclass
class Fields:
    """What the user fills in on the Export page."""

    dataset_name: str
    folder_name: str
    ok_name: str = "OK"
    ng_name: str = "NG"
    ok_color: str = DEFAULT_OK_COLOR
    ng_color: str = DEFAULT_NG_COLOR
    include_without_box: bool = False  # False: a picture with no rectangle is left out
    zip_name: str = ""

    def cleaned(self) -> "Fields":
        out = Fields(
            dataset_name=self.dataset_name.strip(), folder_name=self.folder_name.strip(), ok_name=self.ok_name.strip(),
            ng_name=self.ng_name.strip(), ok_color=self.ok_color.strip(), ng_color=self.ng_color.strip(),
            include_without_box=bool(self.include_without_box), zip_name=self.zip_name.strip(),
        )
        if not out.dataset_name:
            raise DsExportError("Dataset name is empty.")
        _check(out.folder_name, out.ok_name, out.ng_name, out.ok_color, out.ng_color)
        return out


def _check(folder_name: str, ok_name: str, ng_name: str, ok_color: str, ng_color: str, where: str = "") -> None:
    """The rules for one dataset's folder name, class names and colours; ``where`` prefixes the message (``"Dataset camA: "``)."""
    for label, value in (("Picture folder name", folder_name), ("OK class name", ok_name), ("NG class name", ng_name)):
        if not value:
            raise DsExportError(f"{where}{label} is empty.")
    if re.search(r'[\\/:*?"<>|]', folder_name) or folder_name in (".", ".."):
        raise DsExportError(f'{where}The picture folder name cannot contain \\ / : * ? " < > | .')
    if ok_name.casefold() == ng_name.casefold():
        raise DsExportError(f"{where}The OK and NG class names must differ.")
    for label, value in (("OK colour", ok_color), ("NG colour", ng_color)):
        if not _COLOR.match(value):
            raise DsExportError(f"{where}{label} must look like #06e52b.")


def _record(camera: str) -> dict:
    try:
        return json.loads(db.get_setting(camera, SETTING) or "{}")
    except ValueError:
        return {}


def last_fields(camera: str) -> dict | None:
    """The values typed at the last export, so the form comes back filled in; ``None`` before the first one."""
    fields = _record(camera).get("fields")
    return fields if isinstance(fields, dict) else None


def made(camera: str, version_id: int) -> dict | None:
    """The DS zip last made from this version (``zip`` relative to the camera folder, ``written`` pictures), or ``None`` when
    there is none or the file is gone."""
    entry = (_record(camera).get("versions") or {}).get(str(version_id))
    if not entry or not (datamodel.camera_dir(camera) / entry["zip"]).exists():
        return None
    return {"zip": entry["zip"], "written": entry.get("written", 0)}


def _remember(camera: str, version_id: int, fields: Fields, dest: Path, written: int) -> None:
    record = _record(camera)
    record["fields"] = {
        "dataset_name": fields.dataset_name, "folder_name": fields.folder_name, "ok_name": fields.ok_name, "ng_name": fields.ng_name,
        "ok_color": fields.ok_color, "ng_color": fields.ng_color, "include_without_box": fields.include_without_box, "zip_name": fields.zip_name,
    }
    record.setdefault("versions", {})[str(version_id)] = {"zip": str(dest.relative_to(datamodel.camera_dir(camera))), "written": written}
    db.set_setting(camera, SETTING, json.dumps(record))


def zip_file_name(fields: Fields, number: int) -> str:
    """The zip file name: the one typed, or the dataset name plus the version number; always ends in ``.zip``."""
    base = fields.zip_name or f"{fields.dataset_name}_v{number:03d}"
    base = re.sub(r'[\\/:*?"<>|]', "-", base).strip(" .") or f"dataset_v{number:03d}"
    return base if base.lower().endswith(".zip") else base + ".zip"


def _rgb(color: str) -> tuple[int, int, int]:
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def corners(row: list[int], box_format: str) -> tuple[int, int, int, int]:
    """A frozen rectangle row as the two corners ``(x1, y1, x2, y2)`` (edges, the end exclusive)."""
    a, b, c, d = (int(v) for v in row)
    return (a, b, a + c, b + d) if box_format == "size" else (a, b, c, d)


def ds_box(edges: tuple[int, int, int, int], width: int, height: int, label_id: int) -> dict:
    """One DS box: the last pixel inside is ``end - 1``; everything is clamped into ``0 .. width-1`` / ``0 .. height-1``."""
    x1, y1, x2, y2 = edges
    left = min(max(x1, 0), width - 1)
    top = min(max(y1, 0), height - 1)
    return {
        "X1": left, "X2": min(max(x2 - 1, left), width - 1),
        "Y1": top, "Y2": min(max(y2 - 1, top), height - 1),
        "LabelDefinitionNodeId": label_id,
    }


def select(pictures: list[dict], fields: Fields) -> list[dict]:
    """The pictures that go into the file: every one, or only those with a rectangle."""
    return [p for p in pictures if fields.include_without_box or p.get("box") is not None]


def _label(name: str, color: str, node_id: int) -> dict:
    r, g, b = _rgb(color)
    return {
        "NodeId": node_id, "Name": name, "Note": name, "NormalizedName": name.upper(), "AvatarImage": ds_assets.AVATAR_PNG,
        "LabelDefinitionScope": LABEL_SCOPE, "Tags": [], "RChannel": r, "GChannel": g, "BChannel": b, "DatasetNodeId": None,
    }


def _image(p: dict, label_of: dict[str, int], folder_path: str) -> dict:
    """One picture of a sub-dataset: ``p`` has ``name``, ``width``, ``height``, ``cls`` (``OK`` / ``NG``) and ``box`` (or ``None``)."""
    w, h = int(p["width"]), int(p["height"])
    boxes = [ds_box(p["box"], w, h, label_of[p["cls"]])] if p.get("box") is not None else []
    return {
        "LabelObjectDetectionBoundingBoxes": boxes, "Name": p["name"], "NormalizedName": p["name"].upper(),
        "FolderPath": folder_path, "Type": IMAGE_TYPE, "Storage": IMAGE_STORAGE, "Width": w, "Height": h,
    }


def build_collection(fields: Fields, pictures: list[dict]) -> dict:
    """``datasetCollection.json`` as a dict, keys in the order of a real DS export. ``pictures`` are dicts with ``name`` (the
    file name without extension), ``width``, ``height``, ``cls`` (``OK`` / ``NG``) and ``box`` (``(x1, y1, x2, y2)`` edges or
    ``None``); they are written in the order given."""
    label_of = {"OK": OK_ID, "NG": NG_ID}
    images = [_image(p, label_of, FOLDER_PATH) for p in select(pictures, fields)]
    return {
        "Name": fields.dataset_name, "Note": fields.dataset_name, "NormalizedName": fields.dataset_name.upper(),
        "AvatarImage": ds_assets.AVATAR_PNG, "Tags": [],
        "ObjectDetectionLabelDefinitions": {
            str(NG_ID): _label(fields.ng_name, fields.ng_color, NG_ID),
            str(OK_ID): _label(fields.ok_name, fields.ok_color, OK_ID),
        },
        "SegmentationLabelDefinitions": {}, "ClassificationLabelDefinitions": {},
        "ObjectDetectionArchiveDatasets": [{
            "Images": images, "NodeId": DATASET_ID, "NormalizedName": fields.folder_name.upper(), "Name": fields.folder_name,
            "Note": fields.folder_name, "Tags": [], "AvatarImage": ds_assets.AVATAR_JPEG,
        }],
        "SegmentationArchiveDatasets": [], "ClassificationArchiveDatasets": [],
    }


def write_collection_zip(dest: Path, collection: dict, files: list[tuple[str, str, Path]]) -> None:
    """The zip: ``datasetCollection.json`` and ``<folder>/<file name>`` for each ``(folder, file name, source)``, side by side at
    the root. Pictures are stored as they are. The zip is written under a temporary name and renamed when complete."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    try:
        with zipfile.ZipFile(part, "w") as z:
            z.writestr("datasetCollection.json", json.dumps(collection, separators=(",", ":"), ensure_ascii=False), compress_type=zipfile.ZIP_DEFLATED)
            for folder, arcname, src in files:
                z.write(src, f"{folder}/{arcname}", compress_type=zipfile.ZIP_STORED)
        os.replace(part, dest)
    finally:
        part.unlink(missing_ok=True)


def write_zip(dest: Path, collection: dict, folder: str, files: list[tuple[str, Path]]) -> None:
    """The zip of one sub-dataset: ``datasetCollection.json`` and ``<folder>/<file name>`` side by side."""
    write_collection_zip(dest, collection, [(folder, arcname, src) for arcname, src in files])


@dataclass
class Collected:
    """The pictures of one frozen step-2 version that DS can take: ``pictures`` (dicts as ``build_collection`` wants them, plus
    ``frame`` and ``hash``), ``sources`` (picture ``name`` -> file name and path), ``report`` and the version's ``number``."""

    pictures: list[dict]
    sources: dict[str, tuple[str, Path]]
    report: dict
    number: int


def collect(camera: str, version_id: int) -> Collected:
    """Read a frozen step-2 version: its OK / NG pictures with the frozen rectangles. Missing or changed pictures, same-name
    pictures and other classes are reported, not collected."""
    from PIL import Image  # noqa: PLC0415

    con = db.connect()
    try:
        v = con.execute("SELECT * FROM versions WHERE id=? AND camera=? AND feature=?", (version_id, camera, versions.PROJECT)).fetchone()
    finally:
        con.close()
    if v is None:
        raise DsExportError(f"No such version id {version_id}.")
    rectangles = ((json.loads(v["stats_json"] or "{}").get("export") or {}).get("rectangles")) or None
    if not rectangles:
        raise DsExportError("This freeze holds no rectangles. Freeze the step-2 Export that reads a Box, then export that version.")
    rows, box_format = rectangles.get("rows") or {}, rectangles.get("format") or "corners"
    hmap = labels.hash_map(camera)
    report = {"written": 0, "no_box": 0, "left_out": 0, "missing": [], "hash_mismatch": [], "name_clash": [], "other_class": 0}
    pictures: list[dict] = []
    sources: dict[str, tuple[str, Path]] = {}
    seen: set[str] = set()
    for item in versions.load_items(version_id):
        frame = item["frame"]
        if item["kind"] != "verdict" or frame in seen:
            continue
        seen.add(frame)
        cls = str(item["class"]).split("/")[-1]  # with products the folder is <product>/<class>
        if cls not in ("OK", "NG"):
            report["other_class"] += 1
            continue
        src = datamodel.unsorted_dir(camera) / samples.file_of(frame)
        if not src.exists():
            report["missing"].append(frame)
            continue
        if item["hash"] and labels.frame_hash(camera, frame, hmap) != item["hash"]:
            report["hash_mismatch"].append(frame)
            continue
        name = Path(frame).stem
        if name in sources:
            report["name_clash"].append(frame)
            continue
        try:
            with Image.open(src) as im:
                width, height = im.size
        except Exception:  # noqa: BLE001 - an unreadable picture is reported like a missing one
            report["missing"].append(frame)
            continue
        row = rows.get(frame)
        pictures.append({
            "name": name, "width": width, "height": height, "cls": cls, "box": corners(row, box_format) if row else None,
            "frame": frame, "hash": item["hash"],
        })
        sources[name] = (Path(frame).name, src)
    return Collected(pictures, sources, report, int(v["number"]))


def export(camera: str, version_id: int, fields: Fields) -> tuple[Path, dict]:
    """Write the DS zip of a frozen step-2 version: its OK / NG pictures with the frozen rectangles. Missing or changed
    pictures are reported, not written. Returns ``(zip path, report)``."""
    fields = fields.cleaned()
    got = collect(camera, version_id)
    pictures, sources, report = got.pictures, got.sources, got.report
    kept = select(pictures, fields)
    report["left_out"] = len(pictures) - len(kept)
    report["no_box"] = sum(1 for p in kept if p["box"] is None)
    if not kept:
        raise DsExportError("No picture is left for the file: none has a rectangle. Tick “include pictures without a rectangle” or freeze again with a Box.")
    files = [(sources[p["name"]][0], sources[p["name"]][1]) for p in kept]
    # DS wants the file named <Name><extension>: the frame's own file name, so Name is its stem.
    dest = datamodel.camera_dir(camera) / "exports" / "project" / zip_file_name(fields, got.number)
    write_zip(dest, build_collection(fields, pictures), fields.folder_name, files)
    report["written"] = len(kept)
    _remember(camera, version_id, fields, dest, len(kept))
    return dest, report


# --- dataset collections: several cameras in one file (v1.153.0) ---------------------------------------------------------------

@dataclass
class SubFields:
    """What the user sets for one dataset of a collection: its folder (sub-dataset) name and its OK / NG class names and colours.
    Equal class names in different datasets mean one shared class."""

    folder_name: str
    ok_name: str = "OK"
    ng_name: str = "NG"
    ok_color: str = DEFAULT_OK_COLOR
    ng_color: str = DEFAULT_NG_COLOR

    def cleaned(self, where: str = "") -> "SubFields":
        out = SubFields(self.folder_name.strip(), self.ok_name.strip(), self.ng_name.strip(), self.ok_color.strip().lower(), self.ng_color.strip().lower())
        _check(out.folder_name, out.ok_name, out.ng_name, out.ok_color, out.ng_color, where)
        return out


@dataclass
class Entry:
    """One dataset of a collection: a camera's frozen step-2 version and how it is named."""

    camera: str
    version_id: int
    sub: SubFields


def build_name(model_name: str, number: int) -> str:
    """The collection name of build ``number``: DS refuses a second import of the same name, so every build gets its own."""
    return f"{model_name.strip()}_v{number:03d}"


def check_subs(subs: list[SubFields]) -> list[SubFields]:
    """The cleaned datasets, or a ``DsExportError`` naming the one that is wrong; folder names must differ (ignoring case) because each is a folder in the zip."""
    if not subs:
        raise DsExportError("Choose at least one dataset.")
    cleaned = [s.cleaned(f"Dataset {s.folder_name.strip() or n}: ") for n, s in enumerate(subs, 1)]
    seen: dict[str, str] = {}
    for s in cleaned:
        key = s.folder_name.casefold()
        if key in seen:
            raise DsExportError(f"Two datasets are named '{seen[key]}' and '{s.folder_name}': each dataset is a folder in the zip, so the names must differ.")
        seen[key] = s.folder_name
    return cleaned


def classes_of(subs: list[SubFields]) -> tuple[list[dict], list[str]]:
    """The classes the collection will have and notes worth reading before building.

    Class names equal ignoring case are **one class** (first spelling and first colour win); each class gets a generated id.
    A class is ``{id, name, color, datasets, as_ok, as_ng}`` (``datasets`` in order, ``as_ok`` / ``as_ng``: the datasets that use
    it as their OK / NG class). Notes: two colours for one class, and a class that is OK in one dataset and NG in another."""
    by_key: dict[str, dict] = {}
    notes: list[str] = []
    for sub in subs:
        for role, name, color in (("as_ok", sub.ok_name, sub.ok_color.lower()), ("as_ng", sub.ng_name, sub.ng_color.lower())):
            c = by_key.get(name.casefold())
            if c is None:
                c = by_key[name.casefold()] = {"id": FIRST_CLASS_ID + len(by_key), "name": name, "color": color, "datasets": [], "as_ok": [], "as_ng": []}
            elif c["color"] != color:
                notes.append(f"Class '{c['name']}' has two colours ({c['color']} and {color} in {sub.folder_name}): the first is used.")
            c["datasets"].append(sub.folder_name)
            c[role].append(sub.folder_name)
    for c in by_key.values():
        if c["as_ok"] and c["as_ng"]:
            notes.append(f"Class '{c['name']}' is the OK class of {', '.join(c['as_ok'])} and the NG class of {', '.join(c['as_ng'])}.")
    return list(by_key.values()), notes


def build_multi(collection_name: str, parts: list[tuple[SubFields, list[dict]]]) -> tuple[dict, list[dict], list[str]]:
    """``datasetCollection.json`` of several sub-datasets as ``(collection, classes, notes)``. ``parts`` are each dataset's fields
    and its pictures (dicts as ``build_collection`` wants them, already chosen); everything is written in the order given. Dataset ids
    are 1, 2, 3, ...; class ids come from ``classes_of``."""
    name = collection_name.strip()
    if not name:
        raise DsExportError("Collection name is empty.")
    subs = check_subs([sub for sub, _ in parts])
    classes, notes = classes_of(subs)
    id_of = {c["name"].casefold(): c["id"] for c in classes}
    datasets = []
    for n, (sub, (_, pictures)) in enumerate(zip(subs, parts), 1):
        label_of = {"OK": id_of[sub.ok_name.casefold()], "NG": id_of[sub.ng_name.casefold()]}
        folder_path = f"ObjectDetectionArchiveDatasetImages/{n}"
        datasets.append({
            "Images": [_image(p, label_of, folder_path) for p in pictures], "NodeId": n, "NormalizedName": sub.folder_name.upper(),
            "Name": sub.folder_name, "Note": sub.folder_name, "Tags": [], "AvatarImage": ds_assets.AVATAR_JPEG,
        })
    collection = {
        "Name": name, "Note": name, "NormalizedName": name.upper(), "AvatarImage": ds_assets.AVATAR_PNG, "Tags": [],
        "ObjectDetectionLabelDefinitions": {str(c["id"]): _label(c["name"], c["color"], c["id"]) for c in classes},
        "SegmentationLabelDefinitions": {}, "ClassificationLabelDefinitions": {},
        "ObjectDetectionArchiveDatasets": datasets,
        "SegmentationArchiveDatasets": [], "ClassificationArchiveDatasets": [],
    }
    return collection, classes, notes


@dataclass
class Built:
    """A written collection: the zip, what to tell the user (``report``) and ``manifest``, one row per picture in the zip."""

    dest: Path
    report: dict
    manifest: list[dict]


def export_collection(dest: Path, collection_name: str, entries: list[Entry], include_without_box: bool = False) -> Built:
    """Write one DS collection zip from the pinned freezes of several cameras (one freeze per camera).

    Every freeze is read first and nothing is written when one cannot be read. Pictures are copied byte for byte. A picture
    without a rectangle is left out unless ``include_without_box``. The manifest keeps what DS forgets when it renames
    pictures: per picture the camera, freeze, dataset folder, DS name, original file, app frame, hash, class and box.
    The report has per dataset ``{camera, version, folder, written, ok, ng, no_box, left_out, missing, hash_mismatch, name_clash,
    other_class}``, the total ``written``, the picture ``sizes`` (counts per ``WxH``), the ``classes`` and ``notes``."""
    subs = check_subs([e.sub for e in entries])
    cameras = [e.camera for e in entries]
    if len(set(cameras)) != len(cameras):
        raise DsExportError("One freeze per camera: a camera appears twice.")
    gathered = []
    for entry, sub in zip(entries, subs):
        try:
            got = collect(entry.camera, entry.version_id)
        except DsExportError as exc:
            raise DsExportError(f"{entry.camera}: {exc}") from exc
        kept = [p for p in got.pictures if include_without_box or p.get("box") is not None]
        if not kept:
            raise DsExportError(f"{entry.camera}: no picture is left for dataset '{sub.folder_name}': none has a rectangle (or tick including pictures without one).")
        gathered.append((entry, sub, got, kept))
    parts = [(sub, kept) for _, sub, _, kept in gathered]
    collection, classes, notes = build_multi(collection_name, parts)
    name_of = {c["id"]: c["name"] for c in classes}
    files: list[tuple[str, str, Path]] = []
    manifest: list[dict] = []
    datasets_report = []
    sizes: dict[str, int] = {}
    image_ids = {d["Name"]: {i["Name"]: i["LabelObjectDetectionBoundingBoxes"] for i in d["Images"]} for d in collection["ObjectDetectionArchiveDatasets"]}
    for entry, sub, got, kept in gathered:
        for p in kept:
            arcname, src = got.sources[p["name"]]
            files.append((sub.folder_name, arcname, src))
            sizes[f"{p['width']}x{p['height']}"] = sizes.get(f"{p['width']}x{p['height']}", 0) + 1
            boxes = image_ids[sub.folder_name][p["name"]]
            manifest.append({
                "camera": entry.camera, "version": entry.version_id, "dataset": sub.folder_name, "name": p["name"], "file": arcname,
                "frame": p["frame"], "hash": p["hash"], "class": p["cls"], "ds_class": name_of[boxes[0]["LabelDefinitionNodeId"]] if boxes else None,
                "box": list(p["box"]) if p.get("box") is not None else None, "width": p["width"], "height": p["height"],
            })
        r = got.report
        datasets_report.append({
            "camera": entry.camera, "version": entry.version_id, "folder": sub.folder_name, "written": len(kept),
            "ok": sum(1 for p in kept if p["cls"] == "OK"), "ng": sum(1 for p in kept if p["cls"] == "NG"),
            "no_box": sum(1 for p in kept if p["box"] is None), "left_out": len(got.pictures) - len(kept),
            "missing": r["missing"], "hash_mismatch": r["hash_mismatch"], "name_clash": r["name_clash"], "other_class": r["other_class"],
        })
    write_collection_zip(dest, collection, files)
    report = {
        "written": len(files), "datasets": datasets_report, "sizes": dict(sorted(sizes.items())),
        "classes": classes, "notes": notes,
    }
    return Built(dest, report, manifest)
