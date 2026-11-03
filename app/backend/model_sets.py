"""The datasets a model (a DS dataset collection) can be built from: the step-2 freezes that hold rectangles (plan
``plans/dataset-collection.md``, stage 1).

A dataset is one camera's frozen step-2 Export. This module lists them per camera with what the Models page needs to choose:
the pictures that would be written (OK / NG with a rectangle), the pictures left out, and the **picture sizes**. A freeze made
since v1.152.0 carries its sizes (``stats.export.sizes``); an older one is measured on first use (the image header only) and the
answer is kept in the camera's settings, so it is read once. A size is ``"<width>x<height>"``; a picture that cannot be read
counts under ``"unknown"``.

A freeze whose pictures are not all of one known size is *mixed*. With a size selected, mixed freezes are not listed; without
one they are listed with ``mixed`` set and the count per size.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import datamodel
import db
import samples
import versions

SIZES_SETTING = "models.sizes"  # per camera: {version id: {"WxH": count}}, measured for freezes that carry no sizes
UNKNOWN = "unknown"
_SIZE = re.compile(r"^\d{1,5}x\d{1,5}$")


class SizeError(ValueError):
    """The size filter is not ``<width>x<height>``."""


def parse_size(value: str | None) -> str | None:
    """The size filter as ``"WxH"``, or ``None`` for no filter."""
    if value is None or not value.strip():
        return None
    text = value.strip().lower().replace("×", "x")
    if not _SIZE.match(text):
        raise SizeError("The size must look like 200x200.")
    return text


def picture_size(camera: str, frame: str) -> str:
    """``"WxH"`` of a source picture, read from its header, or ``"unknown"`` when it is missing or unreadable."""
    from PIL import Image  # noqa: PLC0415

    src: Path = datamodel.unsorted_dir(camera) / samples.file_of(frame)
    try:
        with Image.open(src) as im:
            return f"{im.width}x{im.height}"
    except Exception:  # noqa: BLE001 - a missing or broken picture is reported as unknown, like the DS export does
        return UNKNOWN


def size_counts(camera: str, frames: list[str] | set[str]) -> dict[str, int]:
    """How many of the pictures have each size."""
    counts: dict[str, int] = {}
    for frame in frames:
        size = picture_size(camera, frame)
        counts[size] = counts.get(size, 0) + 1
    return dict(sorted(counts.items()))


def _cache(camera: str) -> dict:
    try:
        return json.loads(db.get_setting(camera, SIZES_SETTING) or "{}")
    except ValueError:
        return {}


def _sizes_of(camera: str, version_id: int, export: dict, frames: list[str], cache: dict) -> dict[str, int]:
    """The sizes of a freeze's pictures: frozen with it, else kept from an earlier measuring, else measured now."""
    frozen = export.get("sizes")
    if isinstance(frozen, dict) and frozen:
        return {str(k): int(v) for k, v in frozen.items()}
    kept = cache.get(str(version_id))
    if isinstance(kept, dict) and kept:
        return {str(k): int(v) for k, v in kept.items()}
    measured = size_counts(camera, frames)
    cache[str(version_id)] = measured
    return measured


def _freezes(camera: str) -> list[dict]:
    """Every step-2 freeze of the camera that holds rectangles, newest first, with its counts and sizes."""
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT id, number, name, created, stats_json FROM versions WHERE camera=? AND feature=? AND deleted IS NULL ORDER BY number DESC",
            (camera, versions.PROJECT),
        ).fetchall()
    finally:
        con.close()
    cache = _cache(camera)
    before = json.dumps(cache, sort_keys=True)
    found = []
    for r in rows:
        try:
            export = (json.loads(r["stats_json"] or "{}").get("export")) or {}
        except ValueError:
            continue
        rectangles = (export.get("rectangles") or {}).get("rows")
        if not rectangles:
            continue
        ok = ng = no_rect = 0
        written: list[str] = []
        seen: set[str] = set()
        for item in versions.load_items(r["id"]):
            if item["kind"] != "verdict" or item["frame"] in seen:
                continue
            seen.add(item["frame"])
            cls = str(item["class"]).split("/")[-1]  # with products the folder is <product>/<class>
            if cls not in ("OK", "NG"):
                continue
            if item["frame"] not in rectangles:
                no_rect += 1
                continue
            written.append(item["frame"])
            ok, ng = (ok + 1, ng) if cls == "OK" else (ok, ng + 1)
        sizes = _sizes_of(camera, r["id"], export, written, cache)
        found.append({
            "id": r["id"], "number": r["number"], "name": r["name"], "created": r["created"],
            "ok": ok, "ng": ng, "no_rect": no_rect, "sizes": sizes,
            "size": next(iter(sizes)) if len(sizes) == 1 and UNKNOWN not in sizes else None,
            "mixed": len(sizes) > 1 or UNKNOWN in sizes,
        })
    if json.dumps(cache, sort_keys=True) != before:
        db.set_setting(camera, SIZES_SETTING, json.dumps(cache))
    return found


def datasets(size: str | None = None) -> dict:
    """The freezes a model can be built from, per camera.

    ``cameras``: ``[{camera, freezes: [...]}]`` for cameras with at least one listed freeze, in camera order, each freeze as
    ``{id, number, name, created, ok, ng, no_rect, sizes, size, mixed}``. With ``size`` only freezes whose pictures all have
    that size are listed. ``sizes`` (always over every freeze): the number of freezes per single size, and ``mixed`` the number of
    freezes of mixed sizes, so the page can fill its size choice.
    """
    wanted = parse_size(size)
    per_size: dict[str, int] = {}
    mixed = 0
    cameras = []
    for camera in datamodel.list_cameras():
        everything = _freezes(camera)
        for f in everything:
            if f["mixed"]:
                mixed += 1
            elif f["size"]:
                per_size[f["size"]] = per_size.get(f["size"], 0) + 1
        listed = [f for f in everything if wanted is None or f["size"] == wanted]
        if listed:
            cameras.append({"camera": camera, "freezes": listed})
    return {"size": wanted, "sizes": dict(sorted(per_size.items())), "mixed": mixed, "cameras": cameras}
