"""Per-feature vision settings: pre-processing filter, object mask and object detector.

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

MAX_EXEMPLARS = 3
TOPK_RANGE = (1, 5)
DEFAULT_TOPK = 1
DEFAULT_THRESHOLD = 0.3
METHODS = ("template", "model")  # template matching (exact size, fixed camera) or the OWL-ViT model
DEFAULT_METHOD = "template"
INPUT_SIZES = (768, 512)  # the detector's picture size: the model's own (precise), or a smaller one (about twice as fast, boxes less exact)
DEFAULT_INPUT_SIZE = 768


class SettingsError(ValueError):
    """Malformed detector settings."""


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


def _unit(value, key: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
        raise SettingsError(f"{key!r} must be a number between 0 and 1")
    return float(value)


def clean_box(box) -> dict:
    """Validate a box ``{x, y, w, h}`` normalised to the ROI crop."""
    if not isinstance(box, dict):
        raise SettingsError("Box must be an object")
    out = {k: _unit(box.get(k), k) for k in ("x", "y", "w", "h")}
    if out["w"] <= 0 or out["h"] <= 0:
        raise SettingsError("Box must have a positive size")
    return out


def _clean_detector(det: dict | None) -> dict | None:
    if not det:
        return None
    exemplars = det.get("exemplars") or []
    if not isinstance(exemplars, list) or len(exemplars) > MAX_EXEMPLARS:
        raise SettingsError(f"Use at most {MAX_EXEMPLARS} exemplars")
    clean_ex = []
    for ex in exemplars:
        frame = ex.get("frame") if isinstance(ex, dict) else None
        if not isinstance(frame, str) or not frame:
            raise SettingsError("Exemplar needs a frame name")
        clean_ex.append({"frame": frame, "box": clean_box(ex.get("box"))})
    topk = det.get("topk", DEFAULT_TOPK)
    if isinstance(topk, bool) or not isinstance(topk, int) or not TOPK_RANGE[0] <= topk <= TOPK_RANGE[1]:
        raise SettingsError(f"topk must be a whole number between {TOPK_RANGE[0]} and {TOPK_RANGE[1]}")
    threshold = _unit(det.get("threshold", DEFAULT_THRESHOLD), "threshold")
    method = det.get("method", DEFAULT_METHOD)
    if method not in METHODS:
        raise SettingsError(f"method must be one of {', '.join(METHODS)}")
    size = det.get("size", DEFAULT_INPUT_SIZE)
    if isinstance(size, bool) or size not in INPUT_SIZES:
        raise SettingsError(f"size must be one of {', '.join(str(n) for n in INPUT_SIZES)}")
    return {"exemplars": clean_ex, "topk": topk, "threshold": threshold, "method": method, "size": size}


def anchored(settings: dict) -> bool:
    """True when the mask is enabled and follows detected objects (exemplars are set)."""
    mask, det = settings.get("mask"), settings.get("detector")
    return bool(mask and mask["enabled"] and det and det["exemplars"])


def reference_center(settings: dict) -> tuple[float, float]:
    """Centre of the first exemplar's box: where the mask was drawn relative to the object."""
    box = settings["detector"]["exemplars"][0]["box"]
    return box["x"] + box["w"] / 2, box["y"] + box["h"] / 2


def get(camera: str, feature: str, con=None) -> dict:
    """Stored settings; anything missing or unreadable falls back to "not set"."""
    result: dict = {"filter": None, "mask": None, "detector": None}
    raw = _read(camera, feature, con)
    if not raw:
        return result
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return result
    for field, clean in (
        ("filter", _clean_filter),
        ("mask", _clean_mask),
        ("detector", _clean_detector),
    ):
        try:
            result[field] = clean(data.get(field))
        except (
            KeyError, TypeError, AttributeError,
            preprocess.FilterError, masking.MaskError, SettingsError,
        ):
            pass
    return result


def validate(settings: dict) -> dict:
    """Cleaned copy of ``settings`` (all three parts); raises if any part is invalid."""
    return {
        "filter": _clean_filter(settings.get("filter")),
        "mask": _clean_mask(settings.get("mask")),
        "detector": _clean_detector(settings.get("detector")),
    }


def put(camera: str, feature: str, settings: dict) -> dict:
    """Validate and store ``settings``; raises ``FilterError``/``MaskError``/``SettingsError`` if invalid."""
    clean = validate(settings)
    db.set_setting(camera, _key(feature), json.dumps(clean, sort_keys=True))
    purge_derived(camera, feature)
    return clean


_epoch = 0


def epoch() -> int:
    """Bumped whenever derived data is purged; in-memory results compare it to spot staleness."""
    return _epoch


def purge_derived(camera: str, feature: str) -> None:
    """Drop results/projections/clusters built on embeddings from the previous settings."""
    global _epoch  # noqa: PLW0603
    _epoch += 1
    con = db.connect()
    try:
        for table in ("scatter_cache", "cluster_snapshot", "results_cache"):
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
    if anchored(current):
        active["detector"] = current["detector"]["exemplars"]
    if not any(active.values()):
        return ""
    # Filter-only settings hash exactly as before the mask existed, keeping old caches valid.
    blob = json.dumps(active["filter"] if len(active) == 1 else active, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:8]


def detection_signature(settings: dict) -> str:
    """Fingerprint of what auto detections depend on: filter, exemplars, method (and for the model, its picture size)."""
    import detector  # noqa: PLC0415 - detector imports this module

    det = settings.get("detector") or {}
    method = det.get("method", DEFAULT_METHOD)
    parts = {"filter": settings["filter"], "exemplars": det.get("exemplars", []), "model": detector.MODEL_ID}
    if method != "model":
        parts["method"] = method  # the model method hashes as it always did, so its stored detections stay valid
    elif det.get("size", DEFAULT_INPUT_SIZE) != DEFAULT_INPUT_SIZE:
        parts["size"] = det["size"]  # the picture size matters to the model only, and only when it is not the default
    blob = json.dumps(parts, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:8]


def apply_settings(settings: dict, img, offset: tuple[float, float] | None = None):
    """Filter then mask ``img`` per ``settings`` (a ``get`` result); disabled parts are skipped.

    ``offset`` re-anchors the mask on a detected object (see ``detections.offsets``).
    """
    flt, mask = settings["filter"], settings["mask"]
    if flt:
        img = preprocess.apply(img, flt["name"], flt["params"])
    if mask and mask["enabled"]:
        img = masking.apply(img, mask["shape"], offset or (0.0, 0.0))
    return img
