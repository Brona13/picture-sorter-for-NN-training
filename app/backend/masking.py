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


def rasterize(shape: dict, height: int, width: int) -> np.ndarray:
    """Boolean ``(height, width)`` array, True inside the shape.

    A circle's radius is a fraction of the crop *width*, so it stays round in pixels.
    """
    s = normalize(shape)
    canvas = np.zeros((height, width), np.uint8)
    if s["shape"] == "rect":
        x0, y0 = round(s["x"] * width), round(s["y"] * height)
        x1, y1 = round((s["x"] + s["w"]) * width), round((s["y"] + s["h"]) * height)
        canvas[y0:y1, x0:x1] = 1
    elif s["shape"] == "circle":
        centre = (round(s["cx"] * width), round(s["cy"] * height))
        cv2.circle(canvas, centre, max(1, round(s["r"] * width)), 1, thickness=-1)
    else:
        pts = np.array([[round(p["x"] * width), round(p["y"] * height)] for p in s["points"]], np.int32)
        cv2.fillPoly(canvas, [pts], 1)
    return canvas.astype(bool)


def apply(img: np.ndarray, shape: dict) -> np.ndarray:
    """Copy of ``img`` with everything outside ``shape`` set to ``BLANK_VALUE``."""
    inside = rasterize(shape, img.shape[0], img.shape[1])
    out = np.full_like(img, BLANK_VALUE)
    out[inside] = img[inside]
    return out
