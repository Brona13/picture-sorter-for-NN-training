from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image



import perf
import thumbs


class ThumbnailCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        thumbs.clear_thumbnail_caches()
        self.temp_dir = tempfile.TemporaryDirectory(prefix="picture-sorter-thumb-test-")
        self.path = Path(self.temp_dir.name) / "frame.png"
        pixels = np.zeros((300, 600, 3), dtype=np.uint8)
        pixels[:, :300] = (220, 30, 20)
        pixels[:, 300:] = (15, 40, 225)
        Image.fromarray(pixels).save(self.path)
        self.mtime = self.path.stat().st_mtime_ns

    def tearDown(self) -> None:
        thumbs.clear_thumbnail_caches()
        self.temp_dir.cleanup()

    def test_cutout_cache_returns_bounded_encoded_payload_and_records_hits(self):
        roi = ("left", 0.0, 0.0, 0.5, 1.0)
        with perf.trace("thumb-test", enabled=True, emit=False) as report:
            first = thumbs.cutout_thumb(str(self.path), roi, self.mtime)
            second = thumbs.cutout_thumb(str(self.path), roi, self.mtime)

        self.assertIsInstance(first, bytes)
        self.assertEqual(first, second)
        with Image.open(io.BytesIO(first)) as decoded:
            side = min(300, thumbs.THUMB_WIDTH)  # the 300px-wide crop is only shrunk if wider than the limit
            self.assertEqual((side, side), decoded.size)
            actual = np.asarray(decoded.convert("RGB"), dtype=np.int16)
        expected = np.asarray(
            thumbs._generate_cutout(str(self.path), roi).convert("RGB"),
            dtype=np.int16,
        )
        self.assertLess(float(np.abs(actual - expected).mean()), 2.0)
        self.assertEqual(2, report.counters["thumbnails.requests"])
        self.assertEqual(1, report.counters["thumbnails.cache_misses"])
        self.assertEqual(1, report.counters["thumbnails.cache_hits"])
        info = thumbs.thumbnail_cache_info()["cutout"]
        self.assertEqual(thumbs.THUMB_CACHE_MAX_ENTRIES, info["maxsize"])
        self.assertEqual(1, info["currsize"])

    def test_roi_geometry_is_part_of_cache_key(self):
        left = ("feature", 0.0, 0.0, 0.5, 1.0)
        right = ("feature", 0.5, 0.0, 0.5, 1.0)
        with perf.trace("thumb-roi-test", enabled=True, emit=False) as report:
            left_bytes = thumbs.cutout_thumb(str(self.path), left, self.mtime)
            right_bytes = thumbs.cutout_thumb(str(self.path), right, self.mtime)

        self.assertNotEqual(left_bytes, right_bytes)
        self.assertEqual(2, report.counters["thumbnails.cache_misses"])

    def test_data_uri_cache_is_bounded_and_observable(self):
        roi = ("full", 0.0, 0.0, 1.0, 1.0)
        with perf.trace("uri-test", enabled=True, emit=False) as report:
            first = thumbs.thumb_data_uri(str(self.path), roi, self.mtime, 96)
            second = thumbs.thumb_data_uri(str(self.path), roi, self.mtime, 96)

        self.assertTrue(first.startswith("data:image/jpeg;base64,"))
        self.assertEqual(first, second)
        self.assertEqual(1, report.counters["thumbnail_uri.cache_misses"])
        self.assertEqual(1, report.counters["thumbnail_uri.cache_hits"])
        info = thumbs.thumbnail_cache_info()["data_uri"]
        self.assertEqual(thumbs.THUMB_URI_CACHE_MAX_ENTRIES, info["maxsize"])

    def test_cutout_cache_evicts_entries_at_its_declared_limit(self):
        roi = ("full", 0.0, 0.0, 1.0, 1.0)
        for key_version in range(thumbs.THUMB_CACHE_MAX_ENTRIES + 1):
            thumbs.cutout_thumb(str(self.path), roi, key_version)

        info = thumbs.thumbnail_cache_info()["cutout"]
        self.assertEqual(thumbs.THUMB_CACHE_MAX_ENTRIES, info["currsize"])
        self.assertEqual(thumbs.THUMB_CACHE_MAX_ENTRIES + 1, info["misses"])


if __name__ == "__main__":
    unittest.main()
