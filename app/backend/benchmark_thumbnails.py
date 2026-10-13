"""Benchmark thumbnail generation and cache behavior using synthetic images.

The benchmark never reads or writes the application's configured camera roots or
database. Run it from the repository root with the project virtual environment.
"""

from __future__ import annotations

import argparse
import io
import json
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw

import perf
import ui_common


PAGE_SIZES = (24, 48, 96)


def _make_frames(root: Path, count: int, width: int, height: int) -> list[Path]:
    paths: list[Path] = []
    for index in range(count):
        image = Image.new(
            "RGB",
            (width, height),
            ((index * 29) % 256, (index * 53) % 256, (index * 97) % 256),
        )
        draw = ImageDraw.Draw(image)
        draw.rectangle(
            (
                width // 8,
                height // 8,
                width * 7 // 8,
                height * 7 // 8,
            ),
            outline=(255, 255, 255),
            width=max(1, width // 80),
        )
        draw.text((16, 16), f"frame {index:03d}", fill=(255, 255, 255))
        path = root / f"frame_{index:03d}.jpg"
        image.save(path, format="JPEG", quality=92)
        paths.append(path)
    return paths


def _clear_thumbnail_caches() -> None:
    clear_all = getattr(ui_common, "clear_thumbnail_caches", None)
    if clear_all is not None:
        clear_all()
        return
    for function in (ui_common.cutout_thumb, ui_common.square_thumb, ui_common.thumb_data_uri):
        clear = getattr(function, "clear", None)
        if clear is not None:
            clear()


def _render(paths: list[Path], roi_tuple: tuple, renderer) -> tuple[float, list[object]]:
    started = time.perf_counter()
    thumbs: list[object] = []
    for path in paths:
        thumbs.append(renderer(str(path), roi_tuple, path.stat().st_mtime_ns))
    return (time.perf_counter() - started) * 1_000.0, thumbs


def _payload_estimates(thumbs: list[object]) -> dict[str, int | str]:
    images = [
        Image.open(io.BytesIO(value)) if isinstance(value, bytes) else value
        for value in thumbs
    ]
    raw_bytes = sum(image.width * image.height * len(image.getbands()) for image in images)
    if thumbs and isinstance(thumbs[0], bytes):
        return {
            "cache_representation": "encoded_bytes",
            "decoded_pixel_bytes": raw_bytes,
            "cache_payload_bytes": sum(len(value) for value in thumbs),
        }
    jpeg_bytes = 0
    for image in images:
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=85, optimize=True)
        jpeg_bytes += buffer.tell()
    return {
        "cache_representation": "decoded_pil",
        "decoded_pixel_bytes": raw_bytes,
        "cache_payload_bytes": raw_bytes,
        "reference_jpeg_bytes": jpeg_bytes,
    }


def run(frame_count: int, width: int, height: int) -> dict[str, object]:
    roi_tuple = ("benchmark", 0.125, 0.125, 0.75, 0.75)
    results: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="picture-sorter-thumbs-") as temp_dir:
        paths = _make_frames(Path(temp_dir), frame_count, width, height)
        # Initialize the decoder/encoder and cache before the
        # measured loops so the 24-card row does not absorb one-time setup.
        ui_common.cutout_thumb(str(paths[0]), roi_tuple, paths[0].stat().st_mtime_ns)
        for path in paths:
            path.read_bytes()
        _clear_thumbnail_caches()
        for page_size in PAGE_SIZES:
            selected = paths[:page_size]
            _clear_thumbnail_caches()
            with perf.trace("benchmark.thumbnails.cold", enabled=True, emit=False) as cold_trace:
                cold_ms, thumbs = _render(selected, roi_tuple, ui_common.cutout_thumb)
            with perf.trace("benchmark.thumbnails.warm", enabled=True, emit=False) as warm_trace:
                warm_ms, _ = _render(selected, roi_tuple, ui_common.cutout_thumb)
            results.append(
                {
                    "page_size": page_size,
                    "bounded_encoded": {
                        "cold_ms": round(cold_ms, 3),
                        "warm_ms": round(warm_ms, 3),
                        **_payload_estimates(thumbs),
                    },
                    "cold_misses": cold_trace.counters.get("thumbnails.cache_misses", 0),
                    "warm_misses": warm_trace.counters.get("thumbnails.cache_misses", 0),
                }
            )
    return {
        "frame_size": [width, height],
        "thumbnail_width": ui_common.THUMB_WIDTH,
        "cache_info": getattr(ui_common, "thumbnail_cache_info", lambda: None)(),
        "results": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", type=int, default=max(PAGE_SIZES))
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=960)
    args = parser.parse_args()
    if args.frames < max(PAGE_SIZES):
        parser.error(f"--frames must be at least {max(PAGE_SIZES)}")
    print(json.dumps(run(args.frames, args.width, args.height), indent=2))


if __name__ == "__main__":
    main()
