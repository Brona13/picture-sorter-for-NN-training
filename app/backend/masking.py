"""Object masks applied to ROI crops so embeddings cover the object only.

A mask is a rectangle, circle or polygon in coordinates normalised to the ROI crop
(0-1). Pixels outside it are blanked to dark grey; the image stays rectangular.
Pure OpenCV/NumPy on BGR ``uint8`` images.
"""
from __future__ import annotations

import cv2
import numpy as np

BLANK_VALUE = 64  # dark grey outside the mask
MIN_POLYGON_POINTS = 3
SHAPES = ("rect", "circle", "polygon")


class MaskError(ValueError):
    """Malformed or out-of-range mask shape."""


def _num(shape: dict, key: str, lo: float = 0.0, hi: float = 1.0) -> float:
    value = shape.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MaskError(f"Mask field {key!r} must be a number")
    if not lo <= value <= hi:
        raise MaskError(f"Mask field {key!r} must be between {lo} and {hi}")
    return float(value)


def normalize(shape: dict | None) -> dict:
    """Validate ``shape`` and return it with only its known fields."""
    if not isinstance(shape, dict):
        raise MaskError("Mask shape must be an object")
    kind = shape.get("shape")
    if kind == "rect":
        out = {"shape": kind, **{k: _num(shape, k) for k in ("x", "y", "w", "h")}}
        if out["w"] <= 0 or out["h"] <= 0:
            raise MaskError("Rectangle must have a positive size")
        return out
    if kind == "circle":
        out = {"shape": kind, "cx": _num(shape, "cx"), "cy": _num(shape, "cy"), "r": _num(shape, "r")}
        if out["r"] <= 0:
            raise MaskError("Circle radius must be positive")
        return out
    if kind == "polygon":
        points = shape.get("points")
        if not isinstance(points, list) or len(points) < MIN_POLYGON_POINTS:
            raise MaskError(f"Polygon needs at least {MIN_POLYGON_POINTS} points")
        return {"shape": kind, "points": [{"x": _num(p, "x"), "y": _num(p, "y")} for p in points]}
    raise MaskError(f"Unknown mask shape {kind!r}")


def rasterize(
    shape: dict, height: int, width: int, offset: tuple[float, float] = (0.0, 0.0)
) -> np.ndarray:
    """Boolean ``(height, width)`` array, True inside the shape.

    ``offset`` (dx, dy, fractions of the crop) translates the shape, e.g. to re-anchor it on a
    detected object; parts moved outside the crop are clipped. A circle's radius is a fraction
    of the crop *width*, so it stays round in pixels.
    """
    s = normalize(shape)
    dx, dy = offset
    canvas = np.zeros((height, width), np.uint8)
    if s["shape"] == "rect":
        x0, y0 = round((s["x"] + dx) * width), round((s["y"] + dy) * height)
        x1, y1 = round((s["x"] + s["w"] + dx) * width), round((s["y"] + s["h"] + dy) * height)
        canvas[max(y0, 0) : max(y1, 0), max(x0, 0) : max(x1, 0)] = 1
    elif s["shape"] == "circle":
        centre = (round((s["cx"] + dx) * width), round((s["cy"] + dy) * height))
        cv2.circle(canvas, centre, max(1, round(s["r"] * width)), 1, thickness=-1)
    else:
        pts = np.array(
            [[round((p["x"] + dx) * width), round((p["y"] + dy) * height)] for p in s["points"]],
            np.int32,
        )
        cv2.fillPoly(canvas, [pts], 1)
    return canvas.astype(bool)


def apply(img: np.ndarray, shape: dict, offset: tuple[float, float] = (0.0, 0.0)) -> np.ndarray:
    """Copy of ``img`` with everything outside ``shape`` (shifted by ``offset``) blanked."""
    inside = rasterize(shape, img.shape[0], img.shape[1], offset)
    out = np.full_like(img, BLANK_VALUE)
    out[inside] = img[inside]
    return out


# --- a mask that follows something (a found target) ----------------------------------------------------------
# A shape drawn on an example picture can be kept *relative to a point* (the centre of a found target) in pixels,
# and put back on any other picture around that point's new place, optionally turned. It is stored as a polygon
# (a rectangle becomes its four corners) or a circle, in pixels, measured from the point.

def relative_shape(shape: dict, width: int, height: int, centre: tuple[float, float]) -> dict:
    """``shape`` (normalised to a ``width`` x ``height`` picture) as pixels measured from ``centre`` (x, y, pixel-edge
    coordinates). A rectangle becomes a polygon so it can be turned."""
    s = normalize(shape)
    cx0, cy0 = float(centre[0]), float(centre[1])
    if s["shape"] == "circle":
        return {"shape": "circle", "cx": round(s["cx"] * width - cx0, 2), "cy": round(s["cy"] * height - cy0, 2), "r": round(s["r"] * width, 2)}
    if s["shape"] == "rect":
        pts = [(s["x"], s["y"]), (s["x"] + s["w"], s["y"]), (s["x"] + s["w"], s["y"] + s["h"]), (s["x"], s["y"] + s["h"])]
    else:
        pts = [(p["x"], p["y"]) for p in s["points"]]
    return {"shape": "polygon", "points": [{"x": round(x * width - cx0, 2), "y": round(y * height - cy0, 2)} for x, y in pts]}


def turn_point(x: float, y: float, degrees: float) -> tuple[float, float]:
    """``(x, y)`` (picture coordinates, y down) turned about the origin by ``degrees`` counter-clockwise as seen on screen."""
    a = np.radians(degrees)
    c, s = float(np.cos(a)), float(np.sin(a))
    return x * c + y * s, -x * s + y * c


def apply_relative(img: np.ndarray, rel: dict, centre: tuple[float, float], turn: float = 0.0) -> np.ndarray:
    """Copy of ``img`` with everything outside ``rel`` blanked, ``rel`` (see :func:`relative_shape`) placed with its
    origin at ``centre`` (x, y, pixel-edge coordinates) and turned by ``turn`` degrees counter-clockwise on screen."""
    height, width = img.shape[:2]
    canvas = np.zeros((height, width), np.uint8)
    cx, cy = float(centre[0]), float(centre[1])
    if rel["shape"] == "circle":
        dx, dy = turn_point(rel["cx"], rel["cy"], turn)
        cv2.circle(canvas, (round(cx + dx), round(cy + dy)), max(1, round(rel["r"])), 1, thickness=-1)
    else:
        pts = np.array([[round(cx + px), round(cy + py)] for px, py in (turn_point(p["x"], p["y"], turn) for p in rel["points"])], np.int32)
        cv2.fillPoly(canvas, [pts], 1)
    inside = canvas.astype(bool)
    out = np.full_like(img, BLANK_VALUE)
    out[inside] = img[inside]
    return out


def clean_relative(rel: object) -> dict:
    """Validate a stored relative shape (pixels from the target; no 0-1 limits)."""
    def num(v, what):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or abs(v) > 1e6:
            raise MaskError(f"{what} must be a number")
        return float(v)

    if not isinstance(rel, dict):
        raise MaskError("Relative mask must be an object")
    if rel.get("shape") == "circle":
        r = num(rel.get("r"), "r")
        if r <= 0:
            raise MaskError("Circle radius must be positive")
        return {"shape": "circle", "cx": num(rel.get("cx"), "cx"), "cy": num(rel.get("cy"), "cy"), "r": r}
    if rel.get("shape") == "polygon":
        pts = rel.get("points")
        if not isinstance(pts, list) or len(pts) < MIN_POLYGON_POINTS:
            raise MaskError(f"Polygon needs at least {MIN_POLYGON_POINTS} points")
        return {"shape": "polygon", "points": [{"x": num(p.get("x"), "x"), "y": num(p.get("y"), "y")} for p in pts]}
    raise MaskError("Unknown relative mask shape")
