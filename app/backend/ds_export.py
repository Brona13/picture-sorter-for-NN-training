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
"""
from __future__ import annotations

import json
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
        for label, value in (("Dataset name", out.dataset_name), ("Picture folder name", out.folder_name), ("OK class name", out.ok_name), ("NG class name", out.ng_name)):
            if not value:
                raise DsExportError(f"{label} is empty.")
        if re.search(r'[\\/:*?"<>|]', out.folder_name) or out.folder_name in (".", ".."):
            raise DsExportError('The picture folder name cannot contain \\ / : * ? " < > | .')
        if out.ok_name.casefold() == out.ng_name.casefold():
            raise DsExportError("The OK and NG class names must differ.")
        for label, value in (("OK colour", out.ok_color), ("NG colour", out.ng_color)):
            if not _COLOR.match(value):
                raise DsExportError(f"{label} must look like #06e52b.")
        return out


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


def build_collection(fields: Fields, pictures: list[dict]) -> dict:
    """``datasetCollection.json`` as a dict, keys in the order of a real DS export. ``pictures`` are dicts with ``name`` (the
    file name without extension), ``width``, ``height``, ``cls`` (``OK`` / ``NG``) and ``box`` (``(x1, y1, x2, y2)`` edges or
    ``None``); they are written in the order given."""
    label_of = {"OK": OK_ID, "NG": NG_ID}
    images = []
    for p in select(pictures, fields):
        w, h = int(p["width"]), int(p["height"])
        boxes = [ds_box(p["box"], w, h, label_of[p["cls"]])] if p.get("box") is not None else []
        images.append({
            "LabelObjectDetectionBoundingBoxes": boxes, "Name": p["name"], "NormalizedName": p["name"].upper(),
            "FolderPath": FOLDER_PATH, "Type": IMAGE_TYPE, "Storage": IMAGE_STORAGE, "Width": w, "Height": h,
        })
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


def write_zip(dest: Path, collection: dict, folder: str, files: list[tuple[str, Path]]) -> None:
    """The zip: ``datasetCollection.json`` and ``<folder>/<file name>`` side by side. Pictures are stored as they are."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w") as z:
        z.writestr("datasetCollection.json", json.dumps(collection, separators=(",", ":"), ensure_ascii=False), compress_type=zipfile.ZIP_DEFLATED)
        for arcname, src in files:
            z.write(src, f"{folder}/{arcname}", compress_type=zipfile.ZIP_STORED)


def export(camera: str, version_id: int, fields: Fields) -> tuple[Path, dict]:
    """Write the DS zip of a frozen step-2 version: its OK / NG pictures with the frozen rectangles. Missing or changed
    pictures are reported, not written. Returns ``(zip path, report)``."""
    from PIL import Image  # noqa: PLC0415

    fields = fields.cleaned()
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
        pictures.append({"name": name, "width": width, "height": height, "cls": cls, "box": corners(row, box_format) if row else None})
        sources[name] = (Path(frame).name, src)
    kept = select(pictures, fields)
    report["left_out"] = len(pictures) - len(kept)
    report["no_box"] = sum(1 for p in kept if p["box"] is None)
    if not kept:
        raise DsExportError("No picture is left for the file: none has a rectangle. Tick “include pictures without a rectangle” or freeze again with a Box.")
    files = [(sources[p["name"]][0], sources[p["name"]][1]) for p in kept]
    # DS wants the file named <Name><extension>: the frame's own file name, so Name is its stem.
    dest = datamodel.camera_dir(camera) / "exports" / "project" / zip_file_name(fields, v["number"])
    write_zip(dest, build_collection(fields, pictures), fields.folder_name, files)
    report["written"] = len(kept)
    _remember(camera, version_id, fields, dest, len(kept))
    return dest, report
