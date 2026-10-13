"""Thumbnail and cutout rendering shared by the API and the (legacy) Streamlit UI.

Pure image code, no UI dependency. Encoded payloads are cached in small bounded
LRU caches keyed by file path, ROI geometry and mtime, so edits can't show stale crops.
"""
from __future__ import annotations

import base64
import io
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image

import engine
import perf
from roi import ROI

THUMB_WIDTH = 240             # px width of cutout thumbnails in the Classify grid
THUMB_CACHE_MAX_ENTRIES = 256
THUMB_URI_CACHE_MAX_ENTRIES = 128
THUMB_JPEG_QUALITY = 90


def bgr_to_pil(bgr: np.ndarray) -> Image.Image:
    return Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))


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
