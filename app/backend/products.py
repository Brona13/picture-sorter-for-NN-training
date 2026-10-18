"""Products of the product-sorting ROI: renaming one without losing anything that carries its name (see ``db.rename_products``)."""
from __future__ import annotations

import sqlite3

import datamodel
import db


class ProductError(ValueError):
    """The rename cannot be done; the message says why (shown to the user)."""


def clean_name(name: object) -> str:
    text = " ".join(str(name).split())
    if not text:
        raise ProductError("A product needs a name.")
    if "/" in text or "\\" in text:
        raise ProductError(f"Product names cannot contain slashes: {text}")
    if datamodel.FEATURE_SEP in text:
        raise ProductError(f"`{datamodel.FEATURE_SEP}` is reserved, please pick a name without it: {text}")
    if text.startswith("@"):
        raise ProductError(f"Product names cannot start with @ (reserved): {text}")
    return text


def check_renames(camera: str, renames: dict[str, str]) -> dict[str, str]:
    """The renames that really change a name, cleaned and checked; raises :class:`ProductError`.

    Every old name must be a product of the camera, a new name must not be in use by another product (rename one at a
    time to swap names) nor by a ROI that would collide, and no two products may get the same new name.
    """
    classify = datamodel.classify_feature(camera)
    if classify is None:
        raise ProductError("This camera has no product-sorting ROI.")
    products = datamodel.products(camera)
    todo: dict[str, str] = {}
    for old, new in renames.items():
        if old not in products:
            raise ProductError(f"Unknown product: {old}")
        new = clean_name(new)
        if new == old:
            continue
        todo[old] = new
    lowered = [n.lower() for n in todo.values()]
    if len(set(lowered)) != len(lowered):
        raise ProductError("Two products cannot get the same name.")
    in_use = {p.lower() for p in products}
    for new in todo.values():
        if new.lower() in in_use:
            raise ProductError(f"A product named {new} already exists. Rename that one first.")
    names = {r.name for r in datamodel.load_rois(camera)}
    for old, new in todo.items():
        clash = [n for n in names if n.partition(datamodel.FEATURE_SEP)[0] == new and datamodel.FEATURE_SEP in n]
        if clash:
            raise ProductError(f"ROIs already exist under the name {new}: {', '.join(sorted(clash))}")
    return todo


def rename_products(camera: str, renames: dict[str, str]) -> dict[str, int]:
    """Rename products; labels, goldens, versions, scores, shared ROIs and the product's own ROIs follow. Raises :class:`ProductError`."""
    todo = check_renames(camera, renames)
    if not todo:
        return {}
    classify = datamodel.classify_feature(camera)
    try:
        moved = db.rename_products(camera, classify, todo)
    except sqlite3.IntegrityError as exc:  # data already sits under a new name; nothing was changed
        raise ProductError("Some data already exists under the new name, so nothing was renamed.") from exc
    datamodel.invalidate_rois(camera)
    datamodel.invalidate_product_membership(camera)
    return moved
