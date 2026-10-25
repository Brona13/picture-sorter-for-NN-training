"""Augmentation ranges: how far the object moves between frames of one ROI.

This tool *measures and records*; it never creates or changes images (training-time augmentation is
out of scope). For every live frame of a feature it estimates, relative to a reference frame:

* the shift ``dx`` (right is positive) and ``dy`` (down is positive) in pixels of the ROI crop, from the
  stored object detection when there is a trusted one (the box centre against the reference frame's),
  otherwise from phase correlation of the two crops (after the feature's pre-processing filter), refined
  by an ECC alignment because a rotated frame biases phase correlation;
* optionally the rotation in degrees (counter-clockwise on screen is positive), from an ECC
  Euclidean alignment of the two crops.

The distribution of these values suggests ranges (the central ``coverage`` percent) that the human edits
and saves. Settings, ranges and per-frame results are metadata in the ``settings`` table; results are
derived and signed, and a freeze records the saved ranges in the version's statistics.
"""
from __future__ import annotations

import hashlib
import json
import math

import cv2
import numpy as np

import db
import detections
import vision_settings
import applog

_log = applog.get("motion")

ALGORITHM = 1  # bump when a measurement changes, so stored results are recomputed
SOURCES = ("auto", "detector", "template")
COVERAGE_RANGE = (50.0, 100.0)
DEFAULT_COVERAGE = 95.0
WORK_SIZE = 320  # longest side, pixels, of the images used for phase correlation and ECC
MIN_RESPONSE = 0.25  # phase-correlation peak below which a shift is not trusted (unrelated images peak at 0.17 or less; matches 0.5+, 0.3 when also rotated by 6 degrees)
MIN_ECC = 0.6  # ECC correlation below which a rotation is not trusted (matches score 0.96+, unrelated images 0.23 or less)
HIST_BINS = 24
_SRC_CODE = {"detector": 1, "template": 2}
_SRC_NAME = {v: k for k, v in _SRC_CODE.items()}


class SettingsError(ValueError):
    """Malformed augmentation settings."""


# --- settings ----------------------------------------------------------------
def _key(feature: str) -> str:
    return f"augmentation.{feature}"


def _results_key(feature: str) -> str:
    return f"augmentation.results.{feature}"


def _range(raw, name: str) -> list[float] | None:
    if raw is None:
        return None
    ok = isinstance(raw, (list, tuple)) and len(raw) == 2 and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in raw
    )
    if not ok:
        raise SettingsError(f"{name} range must be two numbers [low, high]")
    lo, hi = float(raw[0]), float(raw[1])
    if lo > hi:
        raise SettingsError(f"{name} range: low must not exceed high")
    return [lo, hi]


def clean(raw: dict | None) -> dict | None:
    """Validated copy of ``raw`` settings; ``None`` removes them."""
    if not raw:
        return None
    source = raw.get("source", "auto")
    if source not in SOURCES:
        raise SettingsError(f"source must be one of {', '.join(SOURCES)}")
    coverage = raw.get("coverage", DEFAULT_COVERAGE)
    if isinstance(coverage, bool) or not isinstance(coverage, (int, float)) or not COVERAGE_RANGE[0] <= coverage <= COVERAGE_RANGE[1]:
        raise SettingsError(f"coverage must be between {COVERAGE_RANGE[0]:g} and {COVERAGE_RANGE[1]:g} percent")
    reference = raw.get("reference")
    if reference is not None and not isinstance(reference, str):
        raise SettingsError("reference must be a frame name")
    label = raw.get("label")
    if label is not None and not isinstance(label, str):
        raise SettingsError("label must be a class name")
    ranges = raw.get("ranges") or {}
    return {
        "reference": reference or None,
        "source": source,
        "rotation": bool(raw.get("rotation", False)),
        "coverage": float(coverage),
        "label": label or None,
        "ranges": {"dx": _range(ranges.get("dx"), "dx"), "dy": _range(ranges.get("dy"), "dy"), "rot": _range(ranges.get("rot"), "rotation")},
    }


def get(camera: str, feature: str) -> dict | None:
    raw = db.get_setting(camera, _key(feature))
    if not raw:
        return None
    try:
        return clean(json.loads(raw))
    except (ValueError, TypeError, SettingsError):
        return None


def put(camera: str, feature: str, raw: dict | None) -> dict | None:
    """Validate and store; ``None`` removes the settings. Raises :class:`SettingsError`."""
    settings = clean(raw)
    db.set_setting(camera, _key(feature), json.dumps(settings, sort_keys=True) if settings else "")
    return settings


def _detector_part(camera: str, feature: str) -> dict | None:
    """The detector settings that decide which stored boxes are trusted (None without exemplars)."""
    det = vision_settings.get(camera, feature)["detector"]
    return det if det and det["exemplars"] else None


def signature(camera: str, feature: str, settings: dict, reference_hash: str) -> str:
    """Fingerprint of everything a measurement depends on (not the ranges, coverage or label)."""
    vis = vision_settings.get(camera, feature)
    det = _detector_part(camera, feature)
    blob = {
        "algorithm": ALGORITHM,
        "reference": reference_hash,
        "source": settings["source"],
        "rotation": settings["rotation"],
        "filter": vis["filter"],
        "detector": vision_settings.detection_signature(vis) if det else None,
        "threshold": det["threshold"] if det else None,
    }
    return hashlib.sha1(json.dumps(blob, sort_keys=True).encode()).hexdigest()[:10]


# --- measuring ---------------------------------------------------------------
def _work_gray(crop: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    scale = WORK_SIZE / max(gray.shape)
    if scale < 1:
        gray = cv2.resize(gray, (max(8, round(gray.shape[1] * scale)), max(8, round(gray.shape[0] * scale))), interpolation=cv2.INTER_AREA)
    return gray.astype(np.float32)


def _phase_correlate(ref: np.ndarray, img: np.ndarray) -> tuple[tuple[float, float], float]:
    """``cv2.phaseCorrelate`` on copies: it multiplies its inputs by the window *in place* when they need
    no padding, which would degrade a reference image shared by every frame of a run."""
    window = cv2.createHanningWindow((ref.shape[1], ref.shape[0]), cv2.CV_32F)
    return cv2.phaseCorrelate(ref.copy(), img.copy(), window)


def template_shift(ref: np.ndarray, img: np.ndarray, full_size: tuple[int, int]) -> tuple[float, float] | None:
    """Shift ``(dx, dy)`` of ``img`` against ``ref`` in pixels of a ``full_size`` ``(w, h)`` crop.

    Phase correlation on the downscaled grey images; ``None`` when the images differ in size or the
    correlation peak is too weak to trust.
    """
    if ref.shape != img.shape:
        return None
    (sx, sy), response = _phase_correlate(ref, img)
    if response < MIN_RESPONSE:
        return None
    return float(sx * full_size[0] / ref.shape[1]), float(sy * full_size[1] / ref.shape[0])


def _align(ref: np.ndarray, img: np.ndarray, init: tuple[float, float] = (0.0, 0.0)) -> tuple[float, float, float] | None:
    """ECC Euclidean alignment of ``img`` onto ``ref``, started from the shift ``init`` (working pixels).

    Returns ``(dx, dy, rotation)``: the displacement of the image centre in working pixels and the
    rotation in degrees (counter-clockwise on screen positive); ``None`` when ECC does not converge or
    the aligned correlation is low (the images do not correspond).
    """
    if ref.shape != img.shape:
        return None
    warp = np.array([[1, 0, init[0]], [0, 1, init[1]]], dtype=np.float32)
    try:
        cc, warp = cv2.findTransformECC(ref, img, warp, cv2.MOTION_EUCLIDEAN, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-5), None, 5)
    except cv2.error:
        return None
    if cc < MIN_ECC:
        return None
    centre = np.array([ref.shape[1] / 2.0, ref.shape[0] / 2.0, 1.0])
    moved = warp @ centre - centre[:2]
    return float(moved[0]), float(moved[1]), -math.degrees(math.atan2(float(warp[1, 0]), float(warp[0, 0])))


def rotation_deg(ref: np.ndarray, img: np.ndarray, init: tuple[float, float] = (0.0, 0.0)) -> float | None:
    """Rotation of ``img`` against ``ref`` in degrees, counter-clockwise on screen positive."""
    aligned = _align(ref, img, init)
    return None if aligned is None else aligned[2]


def _box_centre(box: dict) -> tuple[float, float]:
    return box["x"] + box["w"] / 2, box["y"] + box["h"] / 2


def reference_frame(camera: str, feature: str, settings: dict | None) -> str | None:
    """The frame everything is measured against: the saved one, else the first golden, else the
    camera's reference frame, else its first frame."""
    import datamodel  # noqa: PLC0415
    import labels  # noqa: PLC0415

    frames = datamodel.frames_for_feature(camera, feature)
    if settings and settings["reference"] in frames:
        return settings["reference"]
    for fs in labels.current_goldens(camera, feature).values():
        for f in fs:
            if f in frames:
                return f
    saved = db.get_setting(camera, "reference_frame")
    if saved in frames:
        return saved
    return frames[0] if frames else None


def measure_frame(
    crop: np.ndarray, ref_work: np.ndarray, *, box: dict | None, ref_centre: tuple[float, float] | None, source: str, rotation: bool,
) -> tuple[float | None, float | None, float | None, str | None]:
    """``(dx, dy, rot, source_used)`` of one frame; values are ``None`` when they could not be measured."""
    h, w = crop.shape[:2]
    dx = dy = None
    used = None
    if source in ("auto", "detector") and box is not None and ref_centre is not None:
        cx, cy = _box_centre(box)
        dx, dy, used = (cx - ref_centre[0]) * w, (cy - ref_centre[1]) * h, "detector"
    work = None
    if dx is None and source in ("auto", "template"):
        work = _work_gray(crop)
        shift = template_shift(ref_work, work, (w, h))
        if shift is not None:
            dx, dy = shift
            used = "template"
    rot = None
    if used == "template" or rotation:
        # Phase correlation is biased when the frame is also rotated, so a template shift is always refined
        # by ECC (seeded with it); the rotation itself is only reported when it was asked for.
        work = work if work is not None else _work_gray(crop)
        sx, sy = ref_work.shape[1] / w, ref_work.shape[0] / h  # full-size pixels -> working pixels
        aligned = _align(ref_work, work, (dx * sx, dy * sy) if dx is not None else (0.0, 0.0))
        if aligned is not None:
            if rotation:
                rot = aligned[2]
            if used == "template":
                dx, dy = aligned[0] / sx, aligned[1] / sy
    return dx, dy, rot, used


def load_results(camera: str, feature: str, signature_now: str) -> dict | None:
    """Stored measurements when they match ``signature_now``: ``{"crop": [w, h], "frames": {hash: [...]}}``."""
    raw = db.get_setting(camera, _results_key(feature))
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return data if data.get("sig") == signature_now else None


def current_signature(camera: str, feature: str, settings: dict | None) -> str | None:
    """Signature a stored result must carry to be fresh (``None`` when the feature has no frames)."""
    import labels  # noqa: PLC0415

    settings = settings or default_settings()
    ref = reference_frame(camera, feature, settings)
    return None if ref is None else signature(camera, feature, settings, labels.frame_hash(camera, ref))


def results_status(camera: str, feature: str) -> str:
    """``"none"`` (never run), ``"fresh"`` or ``"stale"`` (reference, filter, detector or options changed)."""
    raw = db.get_setting(camera, _results_key(feature))
    now = current_signature(camera, feature, get(camera, feature))
    if not raw or now is None:
        return "none"
    try:
        return "fresh" if json.loads(raw).get("sig") == now else "stale"
    except (ValueError, TypeError, AttributeError):
        return "none"


def default_settings() -> dict:
    return clean({"source": "auto"}) or {}


def run(camera: str, feature: str, report=None) -> dict:
    """Measure every live frame of the feature against the reference frame and store the results."""
    import datamodel  # noqa: PLC0415
    import edge_angle  # noqa: PLC0415
    import labels  # noqa: PLC0415

    settings = get(camera, feature) or default_settings()
    ref_name = reference_frame(camera, feature, settings)
    if ref_name is None:
        raise SettingsError("This feature has no frames yet")
    vis = vision_settings.get(camera, feature)
    flt = vis["filter"]
    unsorted = datamodel.unsorted_dir(camera)
    ref_crop = edge_angle.filtered_crop(camera, feature, unsorted / ref_name, flt)
    ref_size = (ref_crop.shape[1], ref_crop.shape[0])
    ref_work = _work_gray(ref_crop)

    hmap = labels.hash_map(camera)
    det = _detector_part(camera, feature)
    stored = detections.load(camera, feature) if det else {}
    sig_det = vision_settings.detection_signature(vis) if det else ""
    threshold = det["threshold"] if det else 1.0
    ref_box = detections.trusted_box(stored.get(hmap.get(ref_name, "")), sig_det, threshold) if det else None
    ref_centre = _box_centre(ref_box) if ref_box else (vision_settings.reference_center(vis) if det else None)

    deleted = db.deleted_frames_of(camera)
    frames = [f for f in datamodel.frames_for_feature(camera, feature) if f not in deleted]
    out: dict[str, list] = {}
    for i, frame in enumerate(frames, 1):
        h = hmap.get(frame)
        if h:
            try:
                crop = ref_crop if frame == ref_name else edge_angle.filtered_crop(camera, feature, unsorted / frame, flt)
                box = detections.trusted_box(stored.get(h), sig_det, threshold) if det else None
                dx, dy, rot, used = measure_frame(
                    crop, ref_work, box=box, ref_centre=ref_centre, source=settings["source"], rotation=settings["rotation"],
                )
            except Exception:  # noqa: BLE001 - an unreadable frame is "not measured", not a failed run
                applog.warn_once(_log, f"motion-{camera}-{h}", "motion not measured for one picture of %s", camera)
                dx = dy = rot = used = None
            out[h] = [None if v is None else round(v, 3) for v in (dx, dy, rot)] + [_SRC_CODE.get(used or "", 0)]
        if report:
            report({"phase": "measuring", "done": i, "total": len(frames)})
    sig = signature(camera, feature, settings, labels.frame_hash(camera, ref_name, hmap))
    db.set_setting(camera, _results_key(feature), json.dumps({"sig": sig, "reference": ref_name, "crop": list(ref_size), "frames": out}))
    return {"measured": sum(1 for v in out.values() if v[0] is not None), "total": len(out), "reference": ref_name}


# --- analysis ----------------------------------------------------------------
def _axis(values: list[float], coverage: float) -> dict | None:
    if not values:
        return None
    arr = np.asarray(values, dtype=np.float64)
    tail = (100.0 - coverage) / 2.0
    lo, hi = (float(np.percentile(arr, tail)), float(np.percentile(arr, 100.0 - tail))) if len(arr) > 1 else (float(arr[0]), float(arr[0]))
    counts, edges = np.histogram(arr, bins=HIST_BINS)
    return {
        "n": int(arr.size),
        "min": float(arr.min()),
        "max": float(arr.max()),
        "mean": float(arr.mean()),
        "median": float(np.median(arr)),
        "suggested": [lo, hi],
        "hist": {"edges": [float(e) for e in edges], "counts": [int(c) for c in counts]},
    }


def analyse(results: dict, *, coverage: float, include: set[str] | None = None) -> dict:
    """Statistics and suggested ranges over the stored results (only the hashes in ``include``, if given)."""
    dx, dy, rot = [], [], []
    sources = {"detector": 0, "template": 0, "none": 0}
    for h, (x, y, r, code) in results["frames"].items():
        if include is not None and h not in include:
            continue
        sources[_SRC_NAME.get(code, "none")] += 1
        if x is not None:
            dx.append(x)
            dy.append(y)
        if r is not None:
            rot.append(r)
    return {
        "crop": results.get("crop"),
        "reference": results.get("reference"),
        "frames": sum(sources.values()),
        "sources": sources,
        "coverage": coverage,
        "dx": _axis(dx, coverage),
        "dy": _axis(dy, coverage),
        "rot": _axis(rot, coverage),
    }


def snapshot(camera: str, feature: str) -> dict | None:
    """What a freeze records: the saved settings and ranges and whether they rest on fresh results."""
    settings = get(camera, feature)
    if settings is None or not any(settings["ranges"].values()):
        return None
    import labels  # noqa: PLC0415

    ref = reference_frame(camera, feature, settings)
    status = results_status(camera, feature)
    crop = None
    if status == "fresh":
        raw = json.loads(db.get_setting(camera, _results_key(feature)) or "{}")
        crop = raw.get("crop")
    return {
        **settings,
        "reference": ref,
        "reference_hash": labels.frame_hash(camera, ref) if ref else None,
        "results": status,
        "crop": crop,
        "unit": "pixels of the ROI crop (dx right, dy down); rotation in degrees counter-clockwise on screen",
    }
