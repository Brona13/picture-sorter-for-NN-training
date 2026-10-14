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
