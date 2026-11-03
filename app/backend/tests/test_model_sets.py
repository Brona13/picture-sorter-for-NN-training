"""The datasets a model can be built from (plan ``plans/dataset-collection.md``, stage 1): step-2 freezes with rectangles, their
OK / NG counts and picture sizes, the size filter, and how an older freeze without sizes is measured once and remembered."""
from __future__ import annotations

import json
import time
from unittest import mock

import cv2
import numpy as np

import datamodel
import db
import ingest
import model_sets
import versions
from tests.api_helpers import ApiTestCase


def write_frames(camera: str, size: tuple[int, int], count: int, prefix: str) -> list[str]:
    """``count`` distinct pictures of ``size`` (width, height) in the camera, indexed."""
    datamodel.ensure_camera_dirs(camera)
    w, h = size
    names = []
    for i in range(count):
        img = np.full((h, w, 3), (i * 40 + len(prefix)) % 256, dtype=np.uint8)
        img[:, : 3 + i] = (255, 10 * i, 200)
        name = f"{prefix}_{i:02d}.png"
        cv2.imwrite(str(datamodel.unsorted_dir(camera) / name), img)
        names.append(name)
    ingest.rebuild_index(camera)
    return names


def freeze(camera: str, items: list[tuple[str, str]], boxed: list[str], sizes: dict | None = None, rectangles: bool = True) -> dict:
    """A project version as a step-2 Export makes it: ``items`` (frame, class folder), a rectangle for each frame in ``boxed``."""
    export: dict = {"goldens_only": 1, "box": "box:1"}
    if rectangles:
        export["rectangles"] = {"box": "box:1", "format": "corners", "rows": {f: [1, 1, 20, 20] for f in boxed}}
    if sizes is not None:
        export["sizes"] = sizes
    return versions.insert_project_version(camera, "t", "", {}, {"export": export}, items)


class ModelSetsTests(ApiTestCase):
    def test_an_older_freeze_is_measured_once_and_remembered(self) -> None:
        f = write_frames("camA", (200, 200), 4, "a")
        freeze("camA", [(f[0], "OK"), (f[1], "OK"), (f[2], "NG"), (f[3], "NG")], boxed=f[:3])  # no sizes frozen, f[3] has no rectangle
        got = model_sets.datasets()["cameras"]
        self.assertEqual([c["camera"] for c in got], ["camA"])
        row = got[0]["freezes"][0]
        self.assertEqual((row["ok"], row["ng"], row["no_rect"]), (2, 1, 1))
        self.assertEqual((row["sizes"], row["size"], row["mixed"]), ({"200x200": 3}, "200x200", False))
        self.assertIn("200x200", json.loads(db.get_setting("camA", model_sets.SIZES_SETTING)).popitem()[1])
        with mock.patch.object(model_sets, "picture_size", side_effect=AssertionError("read the pictures again")):
            again = model_sets.datasets()["cameras"][0]["freezes"][0]
        self.assertEqual(again["sizes"], {"200x200": 3})

    def test_sizes_frozen_with_the_version_are_used_without_reading_pictures(self) -> None:
        f = write_frames("camB", (100, 60), 2, "b")
        freeze("camB", [(f[0], "OK"), (f[1], "NG")], boxed=f, sizes={"100x60": 2})
        with mock.patch.object(model_sets, "picture_size", side_effect=AssertionError("read a picture")):
            row = model_sets.datasets()["cameras"][0]["freezes"][0]
        self.assertEqual((row["size"], row["mixed"], row["ok"], row["ng"]), ("100x60", False, 1, 1))
        self.assertIsNone(db.get_setting("camB", model_sets.SIZES_SETTING))  # nothing measured, nothing kept

    def test_a_mixed_freeze_is_listed_without_a_size_and_hidden_with_one(self) -> None:
        a = write_frames("camA", (200, 200), 2, "a")
        c1 = write_frames("camC", (200, 200), 2, "c")
        datamodel.ensure_camera_dirs("camC")
        cv2.imwrite(str(datamodel.unsorted_dir("camC") / "odd.png"), np.full((60, 100, 3), 99, dtype=np.uint8))
        ingest.rebuild_index("camC")
        freeze("camA", [(a[0], "OK"), (a[1], "NG")], boxed=a)
        freeze("camC", [(c1[0], "OK"), (c1[1], "OK"), ("odd.png", "NG")], boxed=[*c1, "odd.png"])
        everything = model_sets.datasets()
        self.assertEqual((everything["sizes"], everything["mixed"]), ({"200x200": 1}, 1))
        mixed = [c for c in everything["cameras"] if c["camera"] == "camC"][0]["freezes"][0]
        self.assertEqual((mixed["mixed"], mixed["size"], mixed["sizes"]), (True, None, {"100x60": 1, "200x200": 2}))
        only = model_sets.datasets("200x200")
        self.assertEqual([c["camera"] for c in only["cameras"]], ["camA"])
        self.assertEqual(only["size"], "200x200")
        self.assertEqual(model_sets.datasets("100x60")["cameras"], [])  # the mixed freeze is not listed under one of its sizes

    def test_a_missing_picture_counts_as_unknown_and_makes_the_freeze_mixed(self) -> None:
        f = write_frames("camA", (50, 50), 1, "a")
        freeze("camA", [(f[0], "OK"), ("gone.png", "NG")], boxed=[f[0], "gone.png"])
        row = model_sets.datasets()["cameras"][0]["freezes"][0]
        self.assertEqual((row["sizes"], row["size"], row["mixed"]), ({"50x50": 1, "unknown": 1}, None, True))

    def test_only_step_two_freezes_with_rectangles_that_are_not_deleted_are_listed(self) -> None:
        f = write_frames("camA", (200, 200), 3, "a")
        freeze("camA", [(f[0], "OK")], boxed=[], rectangles=False)  # a step-1 Freeze
        gone = freeze("camA", [(f[1], "OK")], boxed=[f[1]], sizes={"200x200": 1})
        keep = freeze("camA", [(f[2], "NG")], boxed=[f[2]], sizes={"200x200": 1})
        con = db.connect()
        try:
            con.execute("UPDATE versions SET deleted=? WHERE id=?", (time.time(), gone["id"]))
            con.commit()
        finally:
            con.close()
        listed = model_sets.datasets()["cameras"][0]["freezes"]
        self.assertEqual([r["id"] for r in listed], [keep["id"]])

    def test_a_product_folder_counts_as_its_class_and_other_classes_are_ignored(self) -> None:
        f = write_frames("camA", (200, 200), 3, "a")
        freeze("camA", [(f[0], "ProductA/OK"), (f[1], "ProductB/NG"), (f[2], "Other")], boxed=f, sizes={"200x200": 3})
        row = model_sets.datasets()["cameras"][0]["freezes"][0]
        self.assertEqual((row["ok"], row["ng"]), (1, 1))

    def test_the_newest_freeze_comes_first_and_cameras_in_name_order(self) -> None:
        b = write_frames("camB", (200, 200), 1, "b")
        a = write_frames("camA", (200, 200), 2, "a")
        freeze("camB", [(b[0], "OK")], boxed=b, sizes={"200x200": 1})
        old = freeze("camA", [(a[0], "OK")], boxed=[a[0]], sizes={"200x200": 1})
        new = freeze("camA", [(a[1], "NG")], boxed=[a[1]], sizes={"200x200": 1})
        got = model_sets.datasets()["cameras"]
        self.assertEqual([c["camera"] for c in got], ["camA", "camB"])
        self.assertEqual([r["id"] for r in got[0]["freezes"]], [new["id"], old["id"]])

    def test_the_size_filter_reads_x_and_the_multiplication_sign_and_refuses_nonsense(self) -> None:
        self.assertEqual(model_sets.parse_size(" 200X200 "), "200x200")
        self.assertEqual(model_sets.parse_size("200×200"), "200x200")
        self.assertIsNone(model_sets.parse_size(None))
        self.assertIsNone(model_sets.parse_size("  "))
        for bad in ("200", "big", "200x", "x200", "200x200x3"):
            with self.assertRaises(model_sets.SizeError):
                model_sets.parse_size(bad)


class ModelsApiTests(ApiTestCase):
    def test_the_endpoint_lists_datasets_and_filters_by_size(self) -> None:
        f = write_frames("camA", (200, 200), 2, "a")
        freeze("camA", [(f[0], "OK"), (f[1], "NG")], boxed=f)
        listed = self.client.get("/api/models/datasets")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json()["sizes"], {"200x200": 1})
        self.assertEqual(listed.json()["cameras"][0]["freezes"][0]["ok"], 1)
        self.assertEqual(self.client.get("/api/models/datasets", params={"size": "200x200"}).json()["cameras"][0]["camera"], "camA")
        self.assertEqual(self.client.get("/api/models/datasets", params={"size": "64x64"}).json()["cameras"], [])
        bad = self.client.get("/api/models/datasets", params={"size": "huge"})
        self.assertEqual(bad.status_code, 422)
        self.assertIn("200x200", bad.json()["detail"])

    def test_no_camera_gives_an_empty_list(self) -> None:
        got = self.client.get("/api/models/datasets").json()
        self.assertEqual((got["cameras"], got["sizes"], got["mixed"]), ([], {}, 0))
