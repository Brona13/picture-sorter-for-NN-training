"""Shared presentation helpers and session-state conventions for Streamlit views.

Centralizing thumbnail rendering, ROI-display geometry, class styling, and
session-state keys keeps the active view modules consistent and avoids duplicate
UI logic.
"""
from __future__ import annotations

import base64
import io
from functools import lru_cache

import cv2
import numpy as np
import streamlit as st
from PIL import Image

import engine
import perf
from roi import ROI

# --- display constants -------------------------------------------------------
DEFAULT_DISPLAY_WIDTH = 900   # fallback ROI-editor image width if viewport unknown
MAX_DISPLAY_WIDTH = 1600      # cap so very wide screens don't over-scale the canvas
THUMB_WIDTH = 240             # px width of cutout thumbnails in the Classify grid
THUMB_CACHE_MAX_ENTRIES = 256
THUMB_URI_CACHE_MAX_ENTRIES = 128
THUMB_JPEG_QUALITY = 90

# --- session-state keys (centralised so modules can't drift) -----------------
INGEST_REPORT_KEY = "ingest_report"


class ScoringProgressUI:
    """Phase-aware Streamlit status used by Classify and Insights scoring."""

    _LABELS = {
        "discovery": "Discovering frames and cache state…",
        "features": "Preparing image features…",
        "comparison": "Comparing frames with references…",
        "persistence": "Saving score results…",
        "presentation": "Preparing results for display…",
    }

    def __init__(self, title: str = "Refreshing scores…") -> None:
        self._status = st.status(title, expanded=True)
        self._bar = self._status.progress(0.0, text=title)
        self._phase: str | None = None
        self._completion_warning: str | None = None

    def __call__(self, update) -> None:
        self.update(update.phase, update.done, update.total, update.detail)

    def update(
        self,
        phase: str,
        done: int = 0,
        total: int = 0,
        detail: str | None = None,
    ) -> None:
        label = self._LABELS.get(phase, phase.replace("_", " ").capitalize())
        if phase != self._phase:
            self._phase = phase
            self._status.update(label=label, state="running", expanded=True)
        fraction = done / total if total else (1.0 if done else 0.0)
        fraction = max(0.0, min(1.0, fraction))
        count_text = f" {done}/{total}" if total else ""
        detail_text = f" · {detail}" if detail else ""
        self._bar.progress(fraction, text=f"{label}{count_text}{detail_text}")

    def complete(self, label: str | None = None) -> None:
        label = label or self._completion_warning or "Scores refreshed"
        self._bar.progress(1.0, text=label)
        self._status.update(label=label, state="complete", expanded=False)

    def warning(self, label: str) -> None:
        self._completion_warning = label

    def error(self, label: str = "Score refresh failed") -> None:
        self._status.update(label=label, state="error", expanded=True)


def ranked_key(camera: str, feature: str, method: str = "cpu") -> str:
    """Session-state key holding the scored candidate list for a camera+feature+method."""
    return f"ranked::{camera}::{feature}::{method}"


def clear_ranked(camera: str, feature: str) -> None:
    """Drop every scored-list cache for a feature, across all scoring methods."""
    prefix = f"ranked::{camera}::{feature}::"
    for k in [key for key in st.session_state if key.startswith(prefix)]:
        del st.session_state[k]


def confirm_delete_key(camera: str, feature: str) -> str:
    """Session-state key flagging that a feature's delete is awaiting confirmation."""
    return f"confirm_del::{camera}::{feature}"


# --- class colours & per-class bars ------------------------------------------
# The familiar quality verdicts keep fixed, meaningful colours; any other class
# (a product name, say) draws from a categorical palette by its position in the
# feature's class list, so a class keeps the same colour across every picture.
_FIXED_CLASS_COLORS = {"OK": "#1a7f37", "NG": "#c62828"}
_CLASS_PALETTE = [
    "#2a78d6", "#eb6834", "#1baf7a", "#c98500",
    "#d55181", "#4a3aa7", "#008300", "#e34948",
]

# A frame is a "close call" when the runner-up class sits within this fraction of
# the leader's distance — on near-duplicate batches that is the signal to look.
CLOSE_CALL_RATIO = 0.90


def class_color(cls: str, classes: list[str] | tuple[str, ...] = ()) -> str:
    if cls in _FIXED_CLASS_COLORS:
        return _FIXED_CLASS_COLORS[cls]
    if cls in classes:
        return _CLASS_PALETTE[list(classes).index(cls) % len(_CLASS_PALETTE)]
    return "#6b7280"


def square_thumb(frame_path: str, roi_tuple: tuple, mtime: float, size: int = 128) -> Image.Image:
    """ROI cutout centre-cropped to a square, so a list of ROIs with very
    different aspect ratios still renders as an even column of thumbnails."""
    pil = _generate_cutout(frame_path, roi_tuple).convert("RGB")
    side = min(pil.width, pil.height)
    left, top = (pil.width - side) // 2, (pil.height - side) // 2
    return pil.crop((left, top, left + side, top + side)).resize((size, size))


@lru_cache(maxsize=THUMB_URI_CACHE_MAX_ENTRIES)
def _cached_thumb_data_uri(
    frame_path: str,
    roi_tuple: tuple,
    mtime: float,
    size: int,
) -> str:
    perf.count("thumbnail_uri.cache_misses")
    with perf.span("thumbnail_uri.generate"):
        buf = io.BytesIO()
        square_thumb(frame_path, roi_tuple, mtime, size).save(
            buf, format="JPEG", quality=80,
        )
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def thumb_data_uri(frame_path: str, roi_tuple: tuple, mtime: float, size: int = 128) -> str:
    """Square ROI thumbnail as an inline ``data:`` URI.

    Embedding the bytes bypasses Streamlit's media-file manager entirely. That
    matters in the ROI editor: the drawable-canvas shim registers its background
    image by hand, and files added just after it can end up **404** — which is
    what left the first two thumbnails permanently broken.
    """
    perf.count("thumbnail_uri.requests")
    hits_before = _cached_thumb_data_uri.cache_info().hits
    value = _cached_thumb_data_uri(frame_path, roi_tuple, mtime, size)
    if _cached_thumb_data_uri.cache_info().hits > hits_before:
        perf.count("thumbnail_uri.cache_hits")
    return value


def feature_label(camera: str, feature: str, product: str | None = None) -> str:
    """Dropdown label for a feature: its short name, flagged when it is a shared ROI
    seen from inside a product (so it's obvious the goldens/labels are common)."""
    import datamodel

    short = datamodel.split_feature(feature)[1]
    if product and datamodel.split_feature(feature)[0] is None:
        return f"{short}  🔗 shared"
    return short


def class_bars_html(
    dists: dict[str, float | None],
    classes: list[str],
    *,
    close_call: float = CLOSE_CALL_RATIO,
) -> str:
    """One small bar per class for a single frame under one scoring method.

    ``dists`` maps class -> distance to that class's nearest golden (``None`` when
    the class has no reference frames yet). Bar length is **relative closeness**,
    ``min(d) / d``: the nearest class fills the bar, a class twice as far fills
    half, and near-equal bars mean "genuinely undecided".

    This is a *similarity advisory, not a probability* — the lengths deliberately
    do not sum to anything. ``novelty`` (distance to the nearest golden of any
    class) and ``margin`` are derived from the same numbers, matching
    ``classify.MethodScore``, so one component owns the whole readout.
    """
    import html

    present = [d for d in dists.values() if d is not None]
    if not present:
        return ""
    ranked = sorted(present)
    d_min = ranked[0]
    novelty = d_min
    margin = (ranked[1] - ranked[0]) if len(ranked) >= 2 else None
    # Leader = nearest class; ties resolve by the feature's class order.
    leader = min((c for c in classes if dists.get(c) is not None),
                 key=lambda c: dists[c], default=None)
    is_close = len(ranked) >= 2 and ranked[1] > 0 and (d_min / ranked[1]) >= close_call

    rows = []
    for cls in classes:
        d = dists.get(cls)
        name = html.escape(cls)
        if d is None:
            rel, colour, dim, weight = 0.0, "transparent", 0.35, 400
        else:
            rel = 1.0 if d <= 0 else d_min / d
            colour = class_color(cls, classes)
            top = cls == leader
            dim, weight = (1.0 if top else 0.45), (600 if top else 400)
        pct = round(rel * 100, 1)
        if 0 < pct < 2:      # keep a sliver visible rather than vanishing
            pct = 2
        rows.append(
            f"<div style='display:flex;align-items:center;gap:6px;margin:2px 0'>"
            f"<span title='{name}' style='width:40px;flex:none;font-size:10px;"
            f"opacity:{dim};font-weight:{weight};overflow:hidden;text-overflow:ellipsis;"
            f"white-space:nowrap'>{name}</span>"
            f"<span style='flex:1;height:7px;border-radius:4px;"
            f"background:rgba(128,128,128,.22);overflow:hidden'>"
            f"<span style='display:block;height:100%;width:{pct}%;background:{colour};"
            f"opacity:{dim};border-radius:4px'></span></span></div>"
        )

    foot = [f"nov {novelty:.3f}"]
    if margin is not None:
        foot.append(f"margin {margin:.3f}")
    flag = "⚠ close call · " if is_close else ""
    rows.append(
        f"<div style='font-size:10px;opacity:.6;margin-top:3px'>{flag}"
        f"{' · '.join(foot)}</div>"
    )
    return f"<div style='margin:2px 0 6px'>{''.join(rows)}</div>"


# --- viewport / image helpers ------------------------------------------------
# Lets us read the browser viewport width so the ROI image can fill it.
try:
    from streamlit_js_eval import streamlit_js_eval

    HAS_JS_EVAL = True
except Exception:  # pragma: no cover
    HAS_JS_EVAL = False


def editor_display_width() -> int:
    """Width (px) to render the ROI editor image at — fill the content area using the
    browser viewport width, with a safe fallback when JS eval is unavailable."""
    if not HAS_JS_EVAL:
        return DEFAULT_DISPLAY_WIDTH
    try:
        vw = streamlit_js_eval(js_expressions="window.innerWidth", key="viewport_w")
    except Exception:
        vw = None
    if not vw:
        return DEFAULT_DISPLAY_WIDTH
    content = int(vw) - 380  # leave room for the sidebar + page padding
    return max(480, min(content, MAX_DISPLAY_WIDTH))


def bgr_to_pil(bgr: np.ndarray) -> Image.Image:
    return Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))


def roi_key(roi: ROI) -> tuple:
    """A hashable tuple identifying a ROI (used as a cache key)."""
    return (roi.name, roi.x, roi.y, roi.w, roi.h)


# --- drawable-canvas geometry -------------------------------------------------
# One place for the normalised <-> canvas-pixel conversion, so the "draw a new
# ROI" and "move & resize an existing one" paths can never drift apart.
def fabric_rect(roi: ROI, disp_w: int, disp_h: int) -> dict:
    """A fabric.js rect object for ``roi``, ready for ``st_canvas(initial_drawing=…)``."""
    return {
        "type": "rect",
        "left": roi.x * disp_w,
        "top": roi.y * disp_h,
        "width": roi.w * disp_w,
        "height": roi.h * disp_h,
        "scaleX": 1,
        "scaleY": 1,
        "angle": 0,
        "fill": "rgba(255, 165, 0, 0.2)",
        "stroke": "#ff3030",
        "strokeWidth": 2,
    }


def box_from_object(obj: dict, disp_w: int, disp_h: int) -> tuple[float, float, float, float]:
    """Canvas rect -> normalised ``(x, y, w, h)``, clamped to 0-1.

    ``scaleX``/``scaleY`` matter: resizing with the handles scales the object
    rather than changing its width/height.
    """
    w_px = obj["width"] * obj.get("scaleX", 1)
    h_px = obj["height"] * obj.get("scaleY", 1)
    return (
        max(0.0, min(1.0, obj["left"] / disp_w)),
        max(0.0, min(1.0, obj["top"] / disp_h)),
        max(0.0, min(1.0, w_px / disp_w)),
        max(0.0, min(1.0, h_px / disp_h)),
    )


def _generate_cutout(frame_path: str, roi_tuple: tuple) -> Image.Image:
    """Load, crop, and resize one thumbnail without retaining decoded pixels."""
    roi = ROI(*roi_tuple) if len(roi_tuple) == 5 else ROI.full_frame("whole-frame")
    img = engine.curation.load_image(frame_path)
    cutout = roi.crop(img)
    pil = bgr_to_pil(cutout)
    if pil.width > THUMB_WIDTH:
        ratio = THUMB_WIDTH / pil.width
        pil = pil.resize((THUMB_WIDTH, max(1, int(pil.height * ratio))))
    return pil


@lru_cache(maxsize=THUMB_CACHE_MAX_ENTRIES)
def _cached_cutout_thumb(frame_path: str, roi_tuple: tuple, mtime: float) -> bytes:
    """Generate one immutable JPEG payload for the bounded thumbnail cache."""
    perf.count("thumbnails.cache_misses")
    with perf.span("thumbnails.generate"):
        buf = io.BytesIO()
        _generate_cutout(frame_path, roi_tuple).save(
            buf,
            format="JPEG",
            quality=THUMB_JPEG_QUALITY,
            optimize=True,
        )
        return buf.getvalue()


def cutout_thumb(frame_path: str, roi_tuple: tuple, mtime: float) -> bytes:
    """Return cached JPEG bytes for a ROI crop.

    The immutable encoded payload is cheap for Streamlit to reuse and avoids
    retaining full decoded PIL pixel buffers. Both ``mtime`` and ROI geometry
    are part of the key, so file edits and ROI changes cannot show stale crops.
    """
    perf.count("thumbnails.requests")
    hits_before = _cached_cutout_thumb.cache_info().hits
    value = _cached_cutout_thumb(frame_path, roi_tuple, mtime)
    if _cached_cutout_thumb.cache_info().hits > hits_before:
        perf.count("thumbnails.cache_hits")
    return value


def thumbnail_cache_info() -> dict[str, object]:
    """Expose bounded cache occupancy for diagnostics and regression tests."""
    return {
        "cutout": _cached_cutout_thumb.cache_info()._asdict(),
        "data_uri": _cached_thumb_data_uri.cache_info()._asdict(),
    }


def clear_thumbnail_caches() -> None:
    """Clear both thumbnail representations (primarily for tests/benchmarks)."""
    _cached_cutout_thumb.cache_clear()
    _cached_thumb_data_uri.cache_clear()
