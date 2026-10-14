"""Pre-processing filters applied to ROI crops before features/embeddings.

Pure OpenCV on BGR ``uint8`` images. Each filter declares its parameters (range,
step, default) so the API can serve them to the UI and validate saved settings.
The same settings are applied to every frame of a feature.
"""
from __future__ import annotations

import cv2
import numpy as np

# name -> {label, params: {param: {min, max, step, default}}}
FILTERS: dict[str, dict] = {
    "gaussian": {
        "label": "Gaussian blur",
        "params": {"sigma": {"min": 0.1, "max": 10.0, "step": 0.1, "default": 1.5}},
    },
    "median": {
        "label": "Median blur",
        "params": {"size": {"min": 3, "max": 15, "step": 2, "default": 3}},
    },
    "bilateral": {
        "label": "Bilateral filter",
        "params": {
            "diameter": {"min": 3, "max": 15, "step": 2, "default": 7},
            "sigma_color": {"min": 5, "max": 150, "step": 5, "default": 50},
            "sigma_space": {"min": 5, "max": 150, "step": 5, "default": 50},
        },
    },
    "box": {
        "label": "Box filter",
        "params": {"size": {"min": 2, "max": 15, "step": 1, "default": 3}},
    },
    "nlm": {
        "label": "Non-local means denoising",
        "params": {"strength": {"min": 1, "max": 30, "step": 1, "default": 7}},
    },
    "morph_open": {
        "label": "Morphological open",
        "params": {"size": {"min": 2, "max": 15, "step": 1, "default": 3}},
    },
    "morph_close": {
        "label": "Morphological close",
        "params": {"size": {"min": 2, "max": 15, "step": 1, "default": 3}},
    },
    "shrink_rescale": {
        "label": "Shrink and rescale",
        "params": {"levels": {"min": 1, "max": 4, "step": 1, "default": 1}},
    },
}


class FilterError(ValueError):
    """Unknown filter or an out-of-range / malformed parameter."""


def default_params(name: str) -> dict[str, float]:
    return {k: spec["default"] for k, spec in _spec(name)["params"].items()}


def _spec(name: str) -> dict:
    if name not in FILTERS:
        raise FilterError(f"Unknown filter {name!r}")
    return FILTERS[name]


def normalize(name: str, params: dict | None) -> dict[str, float]:
    """Fill defaults and validate ``params`` against the filter's declared ranges."""
    spec = _spec(name)["params"]
    given = dict(params or {})
    unknown = set(given) - set(spec)
    if unknown:
        raise FilterError(f"Unknown parameter(s) for {name}: {sorted(unknown)}")
    out: dict[str, float] = {}
    for key, s in spec.items():
        value = given.get(key, s["default"])
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise FilterError(f"Parameter {key!r} must be a number")
        if not s["min"] <= value <= s["max"]:
            raise FilterError(f"Parameter {key!r} must be between {s['min']} and {s['max']}")
        out[key] = value
    return out


def _odd(n: float) -> int:
    n = int(round(n))
    return n if n % 2 else n + 1


def apply(img: np.ndarray, name: str, params: dict | None = None) -> np.ndarray:
    """Return a filtered copy of ``img`` (same shape and dtype)."""
    p = normalize(name, params)
    if name == "gaussian":
        return cv2.GaussianBlur(img, (0, 0), float(p["sigma"]))
    if name == "median":
        return cv2.medianBlur(img, _odd(p["size"]))
    if name == "bilateral":
        return cv2.bilateralFilter(
            img, int(p["diameter"]), float(p["sigma_color"]), float(p["sigma_space"])
        )
    if name == "box":
        k = int(p["size"])
        return cv2.blur(img, (k, k))
    if name == "nlm":
        s = float(p["strength"])
        if img.ndim == 3 and img.shape[2] == 3:
            return cv2.fastNlMeansDenoisingColored(img, None, s, s, 7, 21)
        return cv2.fastNlMeansDenoising(img, None, s, 7, 21)
    if name in ("morph_open", "morph_close"):
        k = int(p["size"])
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        op = cv2.MORPH_OPEN if name == "morph_open" else cv2.MORPH_CLOSE
        return cv2.morphologyEx(img, op, kernel)
    # shrink_rescale: pyramid down then up, a binning-like smoothing
    h, w = img.shape[:2]
    out = img
    for _ in range(int(p["levels"])):
        out = cv2.pyrDown(out)
    for _ in range(int(p["levels"])):
        out = cv2.pyrUp(out)
    if out.shape[:2] != (h, w):
        out = cv2.resize(out, (w, h), interpolation=cv2.INTER_LINEAR)
    return out
