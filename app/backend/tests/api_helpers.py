"""Shared fixtures for API tests: temp camera/data roots and synthetic frames."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient

import config
import datamodel
import ingest
from api.main import create_app


def write_frames(camera: str, count: int) -> list[str]:
    """Write ``count`` distinct synthetic PNGs into the camera's unsorted dir and index them."""
    datamodel.ensure_camera_dirs(camera)
    names = []
    for i in range(count):
        img = np.full((40, 60, 3), (i * 37) % 256, dtype=np.uint8)
        img[:, : 5 + i] = (255, 255 - i * 10, i * 20 % 256)
        name = f"frame_{i:03d}.png"
        cv2.imwrite(str(datamodel.unsorted_dir(camera) / name), img)
        names.append(name)
    ingest.rebuild_index(camera)
    return names


class ApiTestCase(unittest.TestCase):
    """Points config at temp dirs (never the real cameras/ or DB) and builds a client."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="picture-sorter-api-test-")
        root = Path(self.tmp.name)
        self._old = (config.CAMERAS_ROOT, config.DATA_DIR)
        config.CAMERAS_ROOT = root / "cameras"
        config.DATA_DIR = root / "data"
        self.client = TestClient(create_app())

    def tearDown(self) -> None:
        config.CAMERAS_ROOT, config.DATA_DIR = self._old
        self.tmp.cleanup()
