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
    "unsharp": {
        "label": "Sharpen (unsharp mask)",
        "params": {
            "amount": {"min": 0.1, "max": 5.0, "step": 0.1, "default": 1.0},
            "sigma": {"min": 0.5, "max": 10.0, "step": 0.1, "default": 1.5},
        },
    },
    "edge_enhance": {
        "label": "Edge enhance",
        "params": {
            "gain": {"min": 0.1, "max": 3.0, "step": 0.1, "default": 0.5},
            "sigma": {"min": 0.5, "max": 5.0, "step": 0.1, "default": 1.0},
        },
    },
    "sobel": {
        "label": "Edge map (Sobel)",
        "params": {
            "size": {"min": 1, "max": 7, "step": 2, "default": 3},
            "gain": {"min": 0.5, "max": 8.0, "step": 0.5, "default": 2.0},
        },
    },
    "canny": {
        "label": "Canny edges",
        "params": {
            "low": {"min": 0, "max": 255, "step": 5, "default": 50},
            "high": {"min": 0, "max": 255, "step": 5, "default": 150},
        },
    },
    "laplacian": {
        "label": "Laplacian",
        "params": {
            "size": {"min": 1, "max": 7, "step": 2, "default": 3},
            "gain": {"min": 0.5, "max": 8.0, "step": 0.5, "default": 2.0},
        },
    },
    "morph_gradient": {
        "label": "Morphological gradient",
        "params": {"size": {"min": 2, "max": 15, "step": 1, "default": 3}},
    },
    "clahe": {
        "label": "Local contrast (CLAHE)",
        "params": {
            "clip": {"min": 1.0, "max": 10.0, "step": 0.5, "default": 2.0},
            "tiles": {"min": 2, "max": 16, "step": 1, "default": 8},
        },
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


def _gray(img: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 and img.shape[2] == 3 else img


def _like(gray: np.ndarray, img: np.ndarray) -> np.ndarray:
    """A single-channel result in the shape of ``img`` (three equal channels for a colour picture)."""
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR) if img.ndim == 3 and img.shape[2] == 3 else gray


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
    if name == "unsharp":
        blur = cv2.GaussianBlur(img, (0, 0), float(p["sigma"]))
        a = float(p["amount"])
        return cv2.addWeighted(img, 1.0 + a, blur, -a, 0)
    if name == "edge_enhance":
        # grey edge strength (gradient magnitude of the lightly smoothed picture), added back onto the picture
        g = cv2.GaussianBlur(_gray(img), (0, 0), float(p["sigma"])).astype(np.float32)
        mag = cv2.magnitude(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))
        add = float(p["gain"]) * mag / 4.0
        out = img.astype(np.float32) + (add[..., None] if img.ndim == 3 else add)
        return np.clip(out, 0, 255).astype(np.uint8)
    if name == "sobel":
        g = _gray(img).astype(np.float32)
        k = int(p["size"])
        mag = cv2.magnitude(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=k), cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=k))
        scale = {1: 1.0, 3: 4.0, 5: 48.0, 7: 640.0}[k]  # normalise so a full step edge is about 255 at gain 1
        return _like(np.clip(mag / scale * float(p["gain"]), 0, 255).astype(np.uint8), img)
    if name == "canny":
        lo, hi = sorted((float(p["low"]), float(p["high"])))
        return _like(cv2.Canny(_gray(img), lo, hi), img)
    if name == "laplacian":
        k = int(p["size"])
        lap = np.abs(cv2.Laplacian(_gray(img).astype(np.float32), cv2.CV_32F, ksize=k))
        scale = {1: 1.0, 3: 1.0, 5: 4.0, 7: 16.0}[k]
        return _like(np.clip(lap / scale * float(p["gain"]), 0, 255).astype(np.uint8), img)
    if name == "morph_gradient":
        k = int(p["size"])
        return cv2.morphologyEx(img, cv2.MORPH_GRADIENT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    if name == "clahe":
        c = cv2.createCLAHE(clipLimit=float(p["clip"]), tileGridSize=(int(p["tiles"]),) * 2)
        if img.ndim == 3 and img.shape[2] == 3:
            lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
            lab[..., 0] = c.apply(lab[..., 0])
            return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
        return c.apply(img)
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
