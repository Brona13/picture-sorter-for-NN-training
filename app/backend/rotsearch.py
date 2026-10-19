"""Rotation-aware template search: where is this example in the picture, and how far is it turned?

The engine behind the chain's Detector boxes (``plans/detector-calc-chain.md``, phase 1). Pure functions on images:
no database, no settings, no model, no PyTorch.

``find`` slides one example crop over a picture at many rotations and returns the best match: the centre of the
example (sub-pixel), the rotation, and the score (normalised correlation, 1 = identical, so a threshold means
something). The search is coarse to fine: a coarse step on a shrunk copy finds a few candidate (angle, place) pairs,
a fine step on the full-size picture refines each, and a parabola through the neighbouring scores gives sub-step
angle and sub-pixel position. ``find_targets`` searches several named examples ("left hole", "right hole").

Conventions
- Pixel coordinates are those of the searched picture: x to the right, y down; a pixel's centre is at its integer
  coordinate. The reported centre is the centre of the example, i.e. the point the example was turned about.
- ``angle`` is in degrees in [0, 360): how far the example must be turned to look like what was found, counter-clockwise
  as seen on screen (OpenCV's positive direction). 0 means unturned.
- Pictures may be grey or colour (colour is converted to grey). Examples need some texture; a flat example matches any
  flat area, so it is refused (``None``).
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

COARSE_STEP = 6.0  # degrees between the angles tried on the shrunk copy
FINE_STEP = 0.5  # degrees between the angles tried around each candidate
COARSE_MIN_SIDE = 20  # the example's shorter side is shrunk to about this many pixels for the coarse pass (never enlarged); 20 was 4x faster than 32 on 500 px pictures with the same accuracy
CANDIDATES = 3  # how many coarse (angle, place) candidates are refined
MIN_TEXTURE = 1.0  # grey-level standard deviation below which an example is "flat"

_MASK_SUPPORTED = True  # masked TM_CCOEFF_NORMED works in this OpenCV build; set False on the first failure


@dataclass(frozen=True)
class Match:
    """One found example. Sizes are the example's own (``w`` x ``h`` pixels, before turning)."""

    x: float
    y: float
    angle: float
    score: float
    w: int
    h: int

    def bbox(self) -> tuple[float, float, float, float]:
        """The axis-aligned box ``(x0, y0, x1, y1)`` around the turned example."""
        t = np.deg2rad(self.angle)
        half_w = (abs(self.w * np.cos(t)) + abs(self.h * np.sin(t))) / 2
        half_h = (abs(self.w * np.sin(t)) + abs(self.h * np.cos(t))) / 2
        return (self.x - half_w, self.y - half_h, self.x + half_w, self.y + half_h)

    def region(self, shape: tuple[int, ...], pad: float = 0.0) -> tuple[int, int, int, int]:
        """``bbox`` grown by ``pad`` (a fraction of its size on every side), as whole pixels clipped to a picture of
        ``shape`` (height, width, ...). The search area a second detector uses inside this match."""
        x0, y0, x1, y1 = self.bbox()
        gx, gy = (x1 - x0) * pad, (y1 - y0) * pad
        height, width = shape[:2]
        return (
            max(0, int(np.floor(x0 - gx))),
            max(0, int(np.floor(y0 - gy))),
            min(width, int(np.ceil(x1 + gx)) + 1),
            min(height, int(np.ceil(y1 + gy)) + 1),
        )


def _gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 3:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return np.ascontiguousarray(image, dtype=np.uint8)


def canvas_size(h: int, w: int) -> int:
    """The odd side of the square the example is turned inside: large enough for every rotation."""
    c = int(np.ceil(np.hypot(h, w))) + 2
    return c + (1 - c % 2)


def rotated(template: np.ndarray, angle: float) -> tuple[np.ndarray, np.ndarray]:
    """The example turned by ``angle`` about its centre, on an odd square canvas, and the mask of its valid pixels
    (255 inside the turned example, 0 outside and on its blended edge). The canvas centre is the example centre."""
    h, w = template.shape[:2]
    c = canvas_size(h, w)
    m = cv2.getRotationMatrix2D(((w - 1) / 2.0, (h - 1) / 2.0), float(angle), 1.0)
    m[0, 2] += (c - 1) / 2.0 - (w - 1) / 2.0
    m[1, 2] += (c - 1) / 2.0 - (h - 1) / 2.0
    image = cv2.warpAffine(template, m, (c, c), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    ones = np.full((h, w), 255, np.uint8)
    inside = cv2.warpAffine(ones, m, (c, c), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return image, (inside >= 255).astype(np.uint8) * 255


def _score_map(padded: np.ndarray, template: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Normalised correlation of the turned example at every centre of the picture ``padded`` was made from.

    ``padded`` is the picture grown by half the canvas on every side, so the map has the picture's own shape and
    ``map[y, x]`` is the score of the example centred on pixel ``(x, y)``."""
    global _MASK_SUPPORTED
    if _MASK_SUPPORTED:
        try:
            result = cv2.matchTemplate(padded, template, cv2.TM_CCOEFF_NORMED, mask=mask)
            return np.clip(np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0), -1.0, 1.0)
        except cv2.error:
            _MASK_SUPPORTED = False
    # No masked correlation in this build: fill what is outside the example with its mean grey level, which adds
    # nothing to the correlation of that area, and correlate the whole canvas.
    inside = mask > 0
    filled = template.copy()
    filled[~inside] = int(round(float(template[inside].mean()))) if inside.any() else 0
    result = cv2.matchTemplate(padded, filled, cv2.TM_CCOEFF_NORMED)
    return np.clip(np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0), -1.0, 1.0)


def _pad(image: np.ndarray, half: int) -> np.ndarray:
    return cv2.copyMakeBorder(image, half, half, half, half, cv2.BORDER_REPLICATE)


def _parabola(a: float, b: float, c: float) -> float:
    """Offset (in steps, within -1..1) of the peak of the parabola through ``f(-1)=a``, ``f(0)=b``, ``f(1)=c``."""
    d = a - 2.0 * b + c
    if abs(d) < 1e-12:
        return 0.0
    return float(np.clip(0.5 * (a - c) / d, -1.0, 1.0))


def _subpixel(result: np.ndarray, x: int, y: int) -> tuple[float, float]:
    height, width = result.shape
    dx = _parabola(result[y, x - 1], result[y, x], result[y, x + 1]) if 0 < x < width - 1 else 0.0
    dy = _parabola(result[y - 1, x], result[y, x], result[y + 1, x]) if 0 < y < height - 1 else 0.0
    return dx, dy


def _angles(angle_range: tuple[float, float] | None, step: float) -> tuple[np.ndarray, bool]:
    """The angles to try and whether they close a full circle (so the ends are neighbours)."""
    if angle_range is None:
        return np.arange(0.0, 360.0, step), True
    lo, hi = float(angle_range[0]), float(angle_range[1])
    if hi < lo:
        lo, hi = hi, lo
    if hi - lo >= 360.0:
        return np.arange(lo, lo + 360.0, step), True
    count = int(np.floor((hi - lo) / step + 1e-9)) + 1
    values = lo + step * np.arange(count)
    if hi - values[-1] > 1e-9:
        values = np.append(values, hi)
    return values, False


def _candidates(scores: np.ndarray, circular: bool, keep: int) -> list[int]:
    """Indices of the best local peaks of the coarse scores over the angle, best first."""
    count = len(scores)
    peaks = []
    for i in range(count):
        before = scores[(i - 1) % count] if (circular or i > 0) else -np.inf
        after = scores[(i + 1) % count] if (circular or i < count - 1) else -np.inf
        if scores[i] >= before and scores[i] >= after:
            peaks.append(i)
    peaks.sort(key=lambda i: -scores[i])
    return peaks[:keep]


def find(
    target: np.ndarray,
    template: np.ndarray,
    *,
    angle_range: tuple[float, float] | None = None,
    region: tuple[int, int, int, int] | None = None,
    coarse_step: float = COARSE_STEP,
    fine_step: float = FINE_STEP,
) -> Match | None:
    """The best match of ``template`` in ``target``, or ``None`` when the example is flat or nothing can be searched.

    ``angle_range`` is ``(low, high)`` degrees to try (default: the full circle; ``(0, 0)`` = do not turn).
    ``region`` is ``(x0, y0, x1, y1)`` in pixels: only centres inside it are searched, and the result is in the
    coordinates of the whole ``target`` (a second detector searching inside the box of a first one)."""
    image = _gray(target)
    example = _gray(template)
    h, w = example.shape[:2]
    if h < 3 or w < 3 or float(example.std()) < MIN_TEXTURE:
        return None
    offset_x = offset_y = 0
    if region is not None:
        x0, y0, x1, y1 = (int(v) for v in region)
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(image.shape[1], x1), min(image.shape[0], y1)
        if x1 - x0 < 1 or y1 - y0 < 1:
            return None
        image = image[y0:y1, x0:x1]
        offset_x, offset_y = x0, y0
    height, width = image.shape[:2]

    coarse_angles, circular = _angles(angle_range, max(coarse_step, 1e-3))

    # --- coarse pass: shrunk copies, every coarse angle -----------------------------------------------------------
    scale = min(1.0, COARSE_MIN_SIDE / float(min(h, w)))
    if scale < 1.0:
        small = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        small_example = cv2.resize(example, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    else:
        small, small_example = image, example
    if small_example.shape[0] < 3 or small_example.shape[1] < 3 or float(small_example.std()) < MIN_TEXTURE:
        small, small_example, scale = image, example, 1.0
    small_half = (canvas_size(*small_example.shape[:2]) - 1) // 2
    small_padded = _pad(small, small_half)
    coarse_scores = np.full(len(coarse_angles), -2.0)
    coarse_places: list[tuple[int, int]] = [(0, 0)] * len(coarse_angles)
    for i, angle in enumerate(coarse_angles):
        turned, mask = rotated(small_example, angle)
        result = _score_map(small_padded, turned, mask)
        _, best, _, (px, py) = cv2.minMaxLoc(result)
        coarse_scores[i] = best
        coarse_places[i] = (px, py)
    chosen = _candidates(coarse_scores, circular, CANDIDATES)

    # --- fine pass: full-size picture, a window around each candidate ---------------------------------------------
    half = (canvas_size(h, w) - 1) // 2
    padded = _pad(image, half)
    reach = int(np.ceil(2.0 / scale)) + 3 + int(np.ceil(1.0 / max(scale, 1e-3)))  # coarse position uncertainty in pixels
    best_overall: tuple[float, float, float, float] | None = None
    for index in chosen:
        px, py = coarse_places[index]
        cx = int(round((px + 0.5) / scale - 0.5))
        cy = int(round((py + 0.5) / scale - 0.5))
        xlo, xhi = max(0, cx - reach), min(width - 1, cx + reach)
        ylo, yhi = max(0, cy - reach), min(height - 1, cy + reach)
        if xhi < xlo or yhi < ylo:
            continue
        window = padded[ylo : yhi + 2 * half + 1, xlo : xhi + 2 * half + 1]
        centre = float(coarse_angles[index])
        span = coarse_step if (circular or len(coarse_angles) > 1) else 0.0
        fine_angles = np.arange(centre - span, centre + span + 1e-9, fine_step) if span > 0 else np.array([centre])
        if angle_range is not None and not circular:
            lo, hi = min(angle_range), max(angle_range)
            fine_angles = fine_angles[(fine_angles >= lo - 1e-9) & (fine_angles <= hi + 1e-9)]
            if fine_angles.size == 0:
                fine_angles = np.array([centre])
        scores = np.full(len(fine_angles), -2.0)
        results: list[np.ndarray | None] = [None] * len(fine_angles)
        spots: list[tuple[int, int]] = [(0, 0)] * len(fine_angles)
        for k, angle in enumerate(fine_angles):
            turned, mask = rotated(example, angle)
            result = _score_map(window, turned, mask)
            _, best, _, (rx, ry) = cv2.minMaxLoc(result)
            scores[k], results[k], spots[k] = best, result, (rx, ry)
        k = int(np.argmax(scores))
        angle = float(fine_angles[k])
        if 0 < k < len(fine_angles) - 1:
            angle += _parabola(scores[k - 1], scores[k], scores[k + 1]) * fine_step
        rx, ry = spots[k]
        dx, dy = _subpixel(results[k], rx, ry)
        candidate = (float(scores[k]), xlo + rx + dx, ylo + ry + dy, angle)
        if best_overall is None or candidate[0] > best_overall[0]:
            best_overall = candidate
    if best_overall is None:
        return None
    score, x, y, angle = best_overall
    return Match(
        x=float(x + offset_x),
        y=float(y + offset_y),
        angle=float(angle % 360.0),
        score=float(min(score, 1.0)),
        w=w,
        h=h,
    )


def find_targets(
    target: np.ndarray,
    targets: dict[str, list[np.ndarray]],
    **kwargs,
) -> dict[str, Match | None]:
    """Search each named target (``{"left hole": [example, ...], ...}``): the best match over its examples, or
    ``None`` when none of them can be searched. Identity comes from the name, so two identical-looking features
    stay apart as long as their examples include what tells them apart."""
    found: dict[str, Match | None] = {}
    for name, examples in targets.items():
        best: Match | None = None
        for example in examples:
            match = find(target, example, **kwargs)
            if match is not None and (best is None or match.score > best.score):
                best = match
        found[name] = best
    return found
