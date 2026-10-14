"""Per-feature vision settings: the pre-processing filter and the object mask.

Stored as JSON in the ``settings`` table under ``vision.<feature>``, scoped by camera.
``signature`` is folded into score-cache keys so cached vectors computed under other
settings are never reused. No settings -> empty signature -> existing caches stay valid.
"""
from __future__ import annotations

import hashlib
import json

import db
import masking
import preprocess


def _key(feature: str) -> str:
    return f"vision.{feature}"


def _read(camera: str, feature: str, con=None) -> str | None:
    """Raw stored value; reuses ``con`` when the caller already holds a connection."""
    if con is None:
        return db.get_setting(camera, _key(feature))
    row = con.execute(
        "SELECT value FROM settings WHERE camera=? AND key=?", (camera, _key(feature))
    ).fetchone()
    return row["value"] if row else None


def _clean_filter(flt: dict | None) -> dict | None:
    if not flt:
        return None
    return {"name": flt["name"], "params": preprocess.normalize(flt["name"], flt.get("params"))}


def _clean_mask(mask: dict | None) -> dict | None:
    if not mask:
        return None
    return {"enabled": bool(mask.get("enabled")), "shape": masking.normalize(mask.get("shape"))}


def get(camera: str, feature: str, con=None) -> dict:
    """Stored settings; anything missing or unreadable falls back to "not set"."""
    result: dict = {"filter": None, "mask": None}
    raw = _read(camera, feature, con)
    if not raw:
        return result
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return result
    for field, clean in (("filter", _clean_filter), ("mask", _clean_mask)):
        try:
            result[field] = clean(data.get(field))
        except (KeyError, TypeError, AttributeError, preprocess.FilterError, masking.MaskError):
            pass
    return result


def put(camera: str, feature: str, settings: dict) -> dict:
    """Validate and store ``settings``; raises ``FilterError``/``MaskError`` if invalid."""
    clean = {
        "filter": _clean_filter(settings.get("filter")),
        "mask": _clean_mask(settings.get("mask")),
    }
    db.set_setting(camera, _key(feature), json.dumps(clean, sort_keys=True))
    _purge_derived(camera, feature)
    return clean


def _purge_derived(camera: str, feature: str) -> None:
    """Drop projections/clusters built on embeddings from the previous settings."""
    con = db.connect()
    try:
        for table in ("scatter_cache", "cluster_snapshot"):
            con.execute(f"DELETE FROM {table} WHERE camera=? AND feature=?", (camera, feature))
        con.commit()
    finally:
        con.close()


def signature(camera: str, feature: str, con=None) -> str:
    """Short fingerprint of the active settings; ``""`` when nothing is configured."""
    current = get(camera, feature, con)
    mask = current["mask"]
    active = {"filter": current["filter"]}
    if mask and mask["enabled"]:
        active["mask"] = mask["shape"]
    if not any(active.values()):
        return ""
    # Filter-only settings hash exactly as before the mask existed, keeping old caches valid.
    blob = json.dumps(active["filter"] if len(active) == 1 else active, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:8]


def apply_settings(settings: dict, img):
    """Filter then mask ``img`` per ``settings`` (a ``get`` result); disabled parts are skipped."""
    flt, mask = settings["filter"], settings["mask"]
    if flt:
        img = preprocess.apply(img, flt["name"], flt["params"])
    if mask and mask["enabled"]:
        img = masking.apply(img, mask["shape"])
    return img
