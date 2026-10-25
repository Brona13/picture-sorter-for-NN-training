"""Edge-angle rule tool: is the edge in this band at the expected angle and direction?

A rule-based opinion, independent of the embedding methods and never blended with them. The
user draws a line (two points) along an edge and a band around it; for every frame the band of
the ROI crop (after the feature's pre-processing filter) is searched for the edge:

1. The band is straightened into a patch (along the line, across the line).
2. Canny finds edge pixels; only those whose gradient mostly points across the line count (the
   edge must lie within 45 degrees of the drawn line).
3. The band is cut into ``points`` bins along the line and the strongest edge pixel of each bin is
   kept: evenly spread points, at most one per bin.
4. A robust (Huber) least-squares line is fitted through them; its angle is the measurement.
5. Direction comes from the image, not from the drawing order: the angle is reported in
   [0, 180) degrees (counter-clockwise on screen) and the polarity says which side is brighter:
   ``"+"`` when the side to the left of that direction (as seen on screen) is brighter.

Pass/fail compares angle (within a tolerance) and polarity with the expected values. All
coordinates in the settings are normalised to the ROI crop. Settings and results are metadata
in the ``settings`` table; the results are derived and recomputed when the signature changes.
"""
from __future__ import annotations

import hashlib
import json
import math

import cv2
import numpy as np

import db
import preprocess
import vision_settings
import applog

_log = applog.get("edge_angle")

ALGORITHM = 1  # bump when the measurement changes, so stored results are recomputed
POINTS_RANGE = (3, 40)
DEFAULT_POINTS = 10
HALF_WIDTH_RANGE = (0.005, 0.5)  # fraction of the crop's shorter side
DEFAULT_HALF_WIDTH = 0.05
TOLERANCE_RANGE = (0.1, 90.0)
DEFAULT_TOLERANCE = 5.0
MIN_LENGTH_PX = 8.0
MIN_EDGE_STRENGTH = 25.0
SIDE_OFFSETS = (2.0, 3.0, 4.0)  # pixels either side of the fitted line, to read the polarity


class SettingsError(ValueError):
    """Malformed edge-angle settings."""


# --- settings ----------------------------------------------------------------
def _key(feature: str) -> str:
    return f"rules.edge_angle.{feature}"


def _results_key(feature: str) -> str:
    return f"rules.edge_angle.results.{feature}"


def _unit(value, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
        raise SettingsError(f"{name!r} must be a number between 0 and 1")
    return float(value)


def _point(raw, name: str) -> dict:
    if not isinstance(raw, dict):
        raise SettingsError(f"{name} must be an object with x and y")
    return {"x": _unit(raw.get("x"), f"{name}.x"), "y": _unit(raw.get("y"), f"{name}.y")}


def _number(value, name: str, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
        raise SettingsError(f"{name!r} must be a number between {lo} and {hi}")
    return float(value)


def clean(raw: dict | None) -> dict | None:
    """Validated copy of ``raw`` settings; ``None`` means "no edge-angle rule"."""
    if not raw:
        return None
    p1, p2 = _point(raw.get("p1"), "p1"), _point(raw.get("p2"), "p2")
    if (p1["x"], p1["y"]) == (p2["x"], p2["y"]):
        raise SettingsError("The line needs two different points")
    points = raw.get("points", DEFAULT_POINTS)
    if isinstance(points, bool) or not isinstance(points, int) or not POINTS_RANGE[0] <= points <= POINTS_RANGE[1]:
        raise SettingsError(f"points must be a whole number between {POINTS_RANGE[0]} and {POINTS_RANGE[1]}")
    out = {
        "p1": p1,
        "p2": p2,
        "half_width": _number(raw.get("half_width", DEFAULT_HALF_WIDTH), "half_width", *HALF_WIDTH_RANGE),
        "points": points,
        "expected": None,
    }
    exp = raw.get("expected")
    if exp:
        polarity = exp.get("polarity")
        if polarity not in ("+", "-"):
            raise SettingsError("polarity must be '+' or '-'")
        angle = _number(exp.get("angle"), "angle", 0.0, 180.0) % 180.0
        out["expected"] = {
            "angle": angle,
            "tolerance": _number(exp.get("tolerance", DEFAULT_TOLERANCE), "tolerance", *TOLERANCE_RANGE),
            "polarity": polarity,
        }
    return out


def get(camera: str, feature: str) -> dict | None:
    raw = db.get_setting(camera, _key(feature))
    if not raw:
        return None
    try:
        return clean(json.loads(raw))
    except (ValueError, TypeError, SettingsError):
        return None


def put(camera: str, feature: str, raw: dict | None) -> dict | None:
    """Validate and store; ``None`` removes the rule. Raises :class:`SettingsError`."""
    settings = clean(raw)
    if settings is None:
        db.set_setting(camera, _key(feature), "")
        db.set_setting(camera, _results_key(feature), "")
    else:
        db.set_setting(camera, _key(feature), json.dumps(settings, sort_keys=True))
    return settings


def signature(camera: str, feature: str, settings: dict | None = None) -> str:
    """Fingerprint of everything a measurement depends on (not the expected angle)."""
    settings = settings if settings is not None else get(camera, feature)
    if settings is None:
        return ""
    flt = vision_settings.get(camera, feature)["filter"]
    blob = {
        "algorithm": ALGORITHM,
        "filter": flt,
        "line": [settings["p1"], settings["p2"]],
        "half_width": settings["half_width"],
        "points": settings["points"],
    }
    return hashlib.sha1(json.dumps(blob, sort_keys=True).encode()).hexdigest()[:10]


# --- geometry ----------------------------------------------------------------
def _frame(crop_shape: tuple[int, int], settings: dict):
    """Pixel geometry of the band: ``(p1, u, n, length, half_width_px)``."""
    h, w = crop_shape[:2]
    p1 = np.array([settings["p1"]["x"] * w, settings["p1"]["y"] * h], dtype=np.float64)
    p2 = np.array([settings["p2"]["x"] * w, settings["p2"]["y"] * h], dtype=np.float64)
    d = p2 - p1
    length = float(np.hypot(*d))
    u = d / length if length > 0 else np.array([1.0, 0.0])
    n = np.array([-u[1], u[0]])
    return p1, u, n, length, settings["half_width"] * min(w, h)


def band_corners(crop_shape: tuple[int, int], settings: dict) -> list[dict]:
    """The band's four corners, normalised to the crop (for drawing)."""
    h, w = crop_shape[:2]
    p1, u, n, length, hw = _frame(crop_shape, settings)
    pts = [p1 - hw * n, p1 + length * u - hw * n, p1 + length * u + hw * n, p1 + hw * n]
    return [{"x": float(x / w), "y": float(y / h)} for x, y in pts]


def _to_gray(img: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img


def band_patch(crop: np.ndarray, settings: dict) -> np.ndarray | None:
    """The band straightened into a grey patch (rows across the line, columns along it)."""
    gray = _to_gray(crop)
    p1, u, n, length, hw = _frame(gray.shape, settings)
    cols, rows = int(round(length)), int(round(2 * hw))
    if length < MIN_LENGTH_PX or rows < 4:
        return None
    c = (rows - 1) / 2.0
    m = np.array([[u[0], n[0], p1[0] - c * n[0]], [u[1], n[1], p1[1] - c * n[1]]], dtype=np.float64)
    return cv2.warpAffine(
        gray, m, (cols, rows), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE
    )


def _sample(gray: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Bilinear samples of ``gray`` at float positions (clamped to the image)."""
    h, w = gray.shape
    xs, ys = np.clip(xs, 0, w - 1.001), np.clip(ys, 0, h - 1.001)
    x0, y0 = np.floor(xs).astype(int), np.floor(ys).astype(int)
    fx, fy = xs - x0, ys - y0
    g = gray.astype(np.float64)
    return (
        g[y0, x0] * (1 - fx) * (1 - fy) + g[y0, x0 + 1] * fx * (1 - fy)
        + g[y0 + 1, x0] * (1 - fx) * fy + g[y0 + 1, x0 + 1] * fx * fy
    )


# --- measurement -------------------------------------------------------------
NONE_RESULT = {
    "status": "none", "angle": None, "polarity": None, "contrast": None, "rms": None, "n_points": 0,
    "points": [], "line": [], "patch_points": [], "patch_line": [],
}


def measure(crop: np.ndarray, settings: dict) -> dict:
    """Measure the edge angle in ``crop`` (the ROI crop, already filtered).

    ``status`` is ``"ok"`` or ``"none"`` (no usable edge: too few points). On ``"ok"``: ``angle``
    in [0, 180), ``polarity`` ``"+"``/``"-"``, ``contrast`` (brightness difference across the
    edge), ``rms`` (distance of the points from the fitted line, pixels), and the ``points`` used
    and fitted ``line`` endpoints, normalised to the crop for drawing.
    """
    gray = _to_gray(crop)
    h, w = gray.shape
    p1, u, n, length, hw = _frame(gray.shape, settings)
    patch = band_patch(crop, settings)
    if patch is None:
        return dict(NONE_RESULT)
    blurred = cv2.GaussianBlur(patch, (5, 5), 1.0)
    gx = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3)  # along the line
    gy = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3)  # across the line
    mag = np.hypot(gx, gy)
    peak = float(mag.max())
    if peak < MIN_EDGE_STRENGTH:
        return dict(NONE_RESULT)
    high = max(MIN_EDGE_STRENGTH, 0.5 * peak)
    edges = cv2.Canny(blurred, 0.4 * high, high, L2gradient=True) > 0
    edges &= np.abs(gy) >= np.abs(gx)

    rows, cols = patch.shape
    n_bins = settings["points"]
    bounds = np.linspace(0, cols, n_bins + 1).astype(int)
    pts: list[tuple[float, float]] = []
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        if hi <= lo:
            continue
        sub = np.where(edges[:, lo:hi], np.abs(gy[:, lo:hi]), 0.0)
        if sub.max() <= 0:
            continue
        r, c = np.unravel_index(int(np.argmax(sub)), sub.shape)
        pts.append((float(lo + c), float(r)))
    if len(pts) < max(2, n_bins // 2):
        return dict(NONE_RESULT)

    arr = np.array(pts, dtype=np.float32)
    vx, vy, x0, y0 = (float(v) for v in cv2.fitLine(arr, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel())
    # patch direction -> image direction (patch x runs along u, patch y across, along n)
    d_img = vx * u + vy * n
    angle = math.degrees(math.atan2(-d_img[1], d_img[0])) % 180.0
    if angle >= 180.0 - 1e-9:
        angle = 0.0

    # residuals in the patch, and the points' extent along the fitted direction
    normal_p = np.array([-vy, vx])
    resid = (arr - np.array([x0, y0])) @ normal_p
    rms = float(np.sqrt(np.mean(resid**2)))
    along = (arr - np.array([x0, y0])) @ np.array([vx, vy])
    to_img = lambda px, py: p1 + px * u + (py - (rows - 1) / 2.0) * n  # noqa: E731
    centre = np.array([x0, y0])
    ends_patch = [centre + t * np.array([vx, vy]) for t in (float(along.min()), float(along.max()))]
    ends = [to_img(*e) for e in ends_patch]
    pts_img = [to_img(px, py) for px, py in pts]

    # polarity: brightness left of the canonical direction minus right of it
    a = math.radians(angle)
    left = np.array([-math.sin(a), -math.cos(a)])  # image coords (y down)
    cx = np.array([p[0] for p in pts_img])
    cy = np.array([p[1] for p in pts_img])
    plus = np.mean([_sample(gray, cx + left[0] * d, cy + left[1] * d) for d in SIDE_OFFSETS], axis=0)
    minus = np.mean([_sample(gray, cx - left[0] * d, cy - left[1] * d) for d in SIDE_OFFSETS], axis=0)
    contrast = float(np.mean(plus - minus))

    norm = lambda p: {"x": float(p[0] / w), "y": float(p[1] / h)}  # noqa: E731
    return {
        "status": "ok",
        "angle": angle,
        "polarity": "+" if contrast >= 0 else "-",
        "contrast": contrast,
        "rms": rms,
        "n_points": len(pts),
        "points": [norm(p) for p in pts_img],
        "line": [norm(e) for e in ends],
        "patch_points": [{"x": float((px + 0.5) / cols), "y": float((py + 0.5) / rows)} for px, py in pts],
        "patch_line": [{"x": float((e[0] + 0.5) / cols), "y": float((e[1] + 0.5) / rows)} for e in ends_patch],
    }


def verdict(result: dict, expected: dict | None) -> str | None:
    """``"pass"``/``"fail"``/``"undetermined"``, or ``None`` when no expectation is set."""
    if expected is None:
        return None
    if result.get("status") != "ok":
        return "undetermined"
    diff = abs((result["angle"] - expected["angle"] + 90.0) % 180.0 - 90.0)
    return "pass" if diff <= expected["tolerance"] and result["polarity"] == expected["polarity"] else "fail"


def filtered_crop(camera: str, feature: str, frame_path, flt: dict | None) -> np.ndarray:
    """The frame's ROI crop with the feature's pre-processing filter (never the mask)."""
    import engine  # noqa: PLC0415

    crop = engine.crop_for_frame(camera, feature, frame_path)
    return preprocess.apply(crop, flt["name"], flt["params"]) if flt else crop


# --- results over a feature --------------------------------------------------
def load_results(camera: str, feature: str) -> dict[str, dict]:
    """Stored measurements by frame hash; empty when none, or stale for the current settings."""
    raw = db.get_setting(camera, _results_key(feature))
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if data.get("sig") != signature(camera, feature):
        return {}
    return data.get("results", {})


def results_status(camera: str, feature: str) -> str:
    """``"none"`` (never run), ``"fresh"`` or ``"stale"`` (settings or filter changed since)."""
    raw = db.get_setting(camera, _results_key(feature))
    if not raw:
        return "none"
    try:
        sig = json.loads(raw).get("sig")
    except (ValueError, TypeError, AttributeError):
        return "none"
    return "fresh" if sig == signature(camera, feature) else "stale"


def run(camera: str, feature: str, report=None) -> dict:
    """Measure every live frame of the feature and store the results (a background job)."""
    import datamodel  # noqa: PLC0415
    import labels  # noqa: PLC0415

    settings = get(camera, feature)
    if settings is None:
        raise SettingsError("Save the edge-angle line first")
    flt = vision_settings.get(camera, feature)["filter"]
    deleted = db.deleted_frames_of(camera)
    frames = [f for f in datamodel.frames_for_feature(camera, feature) if f not in deleted]
    hmap = labels.hash_map(camera)
    results: dict[str, dict] = {}
    for i, frame in enumerate(frames, 1):
        try:
            crop = filtered_crop(camera, feature, datamodel.unsorted_dir(camera) / frame, flt)
            m = measure(crop, settings)
        except Exception:  # noqa: BLE001 - an unreadable frame is "none", not a failed run
            applog.warn_once(_log, f"edge-{camera}-{frame}", "edge angle not measured for %s/%s", camera, frame)
            m = dict(NONE_RESULT)
        h = hmap.get(frame)
        if h:
            results[h] = {k: m[k] for k in ("status", "angle", "polarity", "contrast", "rms", "n_points")}
        if report:
            report({"phase": "measuring", "done": i, "total": len(frames)})
    db.set_setting(camera, _results_key(feature), json.dumps({"sig": signature(camera, feature), "results": results}))
    return summarize(results, settings["expected"])


def snapshot(camera: str, feature: str) -> dict | None:
    """What a freeze records about the rule: settings, signature and (when fresh) the counts."""
    settings = get(camera, feature)
    if settings is None:
        return None
    status = results_status(camera, feature)
    return {
        "settings": settings,
        "signature": signature(camera, feature),
        "results": status,
        "summary": summarize(load_results(camera, feature), settings["expected"]) if status == "fresh" else None,
    }


def summarize(results: dict[str, dict], expected: dict | None) -> dict:
    counts = {"pass": 0, "fail": 0, "undetermined": 0, "measured": 0}
    for r in results.values():
        v = verdict(r, expected)
        counts[v or "measured"] += 1
    return {"total": len(results), **counts}
