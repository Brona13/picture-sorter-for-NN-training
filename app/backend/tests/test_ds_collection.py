"""A DS collection zip made from the pinned freezes of several cameras (plan ``plans/dataset-collection.md``, stage 2)."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import datamodel
import ds_export
from ds_export import DsExportError, Entry, SubFields
from tests.api_helpers import ApiTestCase
from tests.test_model_sets import freeze, write_frames


class ExportCollectionTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.a = write_frames("camA", (200, 200), 4, "a")
        self.b = write_frames("camB", (200, 200), 2, "b")
        # camA: two OK, one NG with a rectangle, one OK without; camB: one OK, one NG
        self.fa = freeze("camA", [(self.a[0], "OK"), (self.a[1], "OK"), (self.a[2], "NG"), (self.a[3], "OK")], boxed=self.a[:3])
        self.fb = freeze("camB", [(self.b[0], "OK"), (self.b[1], "NG")], boxed=self.b)
        self.dest = Path(self.tmp.name) / "models" / "set_v001.zip"

    def entries(self, shared: bool = False) -> list[Entry]:
        if shared:
            return [Entry("camA", self.fa["id"], SubFields("camA")), Entry("camB", self.fb["id"], SubFields("camB"))]
        return [Entry("camA", self.fa["id"], SubFields("camA", "camA-OK", "camA-NG")), Entry("camB", self.fb["id"], SubFields("camB", "camB-OK", "camB-NG"))]

    def test_the_zip_holds_one_folder_per_camera_and_the_json_beside_them(self) -> None:
        built = ds_export.export_collection(self.dest, "set_v001", self.entries())
        self.assertEqual(built.dest, self.dest)
        with zipfile.ZipFile(self.dest) as z:
            self.assertEqual(sorted(z.namelist()), sorted(["datasetCollection.json", *[f"camA/{n}" for n in self.a[:3]], *[f"camB/{n}" for n in self.b]]))
            data = json.loads(z.read("datasetCollection.json"))
        self.assertEqual([(d["Name"], len(d["Images"])) for d in data["ObjectDetectionArchiveDatasets"]], [("camA", 3), ("camB", 2)])
        self.assertEqual(sorted(l["Name"] for l in data["ObjectDetectionLabelDefinitions"].values()), ["camA-NG", "camA-OK", "camB-NG", "camB-OK"])

    def test_pictures_are_copied_byte_for_byte(self) -> None:
        ds_export.export_collection(self.dest, "set_v001", self.entries())
        with zipfile.ZipFile(self.dest) as z:
            for cam, names in (("camA", self.a[:3]), ("camB", self.b)):
                for n in names:
                    self.assertEqual(z.read(f"{cam}/{n}"), (datamodel.unsorted_dir(cam) / n).read_bytes())

    def test_a_shared_class_is_one_definition_used_by_both_cameras(self) -> None:
        built = ds_export.export_collection(self.dest, "set_v001", self.entries(shared=True))
        with zipfile.ZipFile(self.dest) as z:
            data = json.loads(z.read("datasetCollection.json"))
        defs = data["ObjectDetectionLabelDefinitions"]
        self.assertEqual(sorted(l["Name"] for l in defs.values()), ["NG", "OK"])
        per = {d["Name"]: {defs[str(i["LabelObjectDetectionBoundingBoxes"][0]["LabelDefinitionNodeId"])]["Name"] for i in d["Images"]} for d in data["ObjectDetectionArchiveDatasets"]}
        self.assertEqual(per, {"camA": {"OK", "NG"}, "camB": {"OK", "NG"}})
        self.assertEqual([(c["name"], c["datasets"]) for c in built.report["classes"]], [("OK", ["camA", "camB"]), ("NG", ["camA", "camB"])])

    def test_the_report_counts_what_went_in_and_what_was_left_out(self) -> None:
        r = ds_export.export_collection(self.dest, "set_v001", self.entries()).report
        self.assertEqual(r["written"], 5)
        self.assertEqual(r["sizes"], {"200x200": 5})
        da, db_ = r["datasets"]
        self.assertEqual((da["camera"], da["folder"], da["written"], da["ok"], da["ng"], da["no_box"], da["left_out"]), ("camA", "camA", 3, 2, 1, 0, 1))
        self.assertEqual((db_["written"], db_["ok"], db_["ng"], db_["left_out"]), (2, 1, 1, 0))
        self.assertEqual(r["notes"], [])

    def test_including_pictures_without_a_rectangle_lists_them_with_no_box(self) -> None:
        built = ds_export.export_collection(self.dest, "set_v001", self.entries(), include_without_box=True)
        self.assertEqual(built.report["written"], 6)
        self.assertEqual(built.report["datasets"][0]["no_box"], 1)
        with zipfile.ZipFile(self.dest) as z:
            data = json.loads(z.read("datasetCollection.json"))
        empty = [i for d in data["ObjectDetectionArchiveDatasets"] for i in d["Images"] if not i["LabelObjectDetectionBoundingBoxes"]]
        self.assertEqual([i["Name"] for i in empty], [Path(self.a[3]).stem])

    def test_the_manifest_has_one_row_per_picture_and_keeps_what_ds_forgets(self) -> None:
        built = ds_export.export_collection(self.dest, "set_v001", self.entries())
        self.assertEqual(len(built.manifest), 5)
        row = next(m for m in built.manifest if m["frame"] == self.a[2])
        self.assertEqual((row["camera"], row["version"], row["dataset"], row["name"], row["file"]), ("camA", self.fa["id"], "camA", Path(self.a[2]).stem, self.a[2]))
        self.assertEqual((row["class"], row["ds_class"], row["box"], row["width"], row["height"]), ("NG", "camA-NG", [1, 1, 20, 20], 200, 200))
        self.assertTrue(row["hash"])
        self.assertEqual({m["dataset"] for m in built.manifest}, {"camA", "camB"})

    def test_nothing_is_written_when_one_freeze_cannot_be_read(self) -> None:
        plain = freeze("camB", [(self.b[0], "OK")], boxed=[], rectangles=False)  # a step-1 Freeze
        entries = self.entries()
        entries[1] = Entry("camB", plain["id"], SubFields("camB"))
        with self.assertRaises(DsExportError) as ctx:
            ds_export.export_collection(self.dest, "set_v001", entries)
        self.assertIn("camB", str(ctx.exception))
        self.assertIn("no rectangles", str(ctx.exception))
        self.assertFalse(self.dest.exists())
        self.assertFalse(self.dest.parent.exists())

    def test_a_camera_twice_and_an_empty_choice_are_refused(self) -> None:
        twice = [Entry("camA", self.fa["id"], SubFields("one")), Entry("camA", self.fa["id"], SubFields("two"))]
        with self.assertRaises(DsExportError) as ctx:
            ds_export.export_collection(self.dest, "set_v001", twice)
        self.assertIn("One freeze per camera", str(ctx.exception))
        with self.assertRaises(DsExportError):
            ds_export.export_collection(self.dest, "set_v001", [])

    def test_a_dataset_with_no_picture_left_is_refused_by_name(self) -> None:
        ghost = freeze("camB", [(self.b[0], "OK")], boxed=["other.png"])  # a rectangle row, but not for the frozen picture
        with self.assertRaises(DsExportError) as ctx:
            ds_export.export_collection(self.dest, "set_v001", [Entry("camB", ghost["id"], SubFields("only-b"))])
        self.assertIn("only-b", str(ctx.exception))
        self.assertFalse(self.dest.exists())

    def test_a_missing_picture_is_reported_for_its_dataset_and_not_written(self) -> None:
        (datamodel.unsorted_dir("camA") / self.a[1]).unlink()
        r = ds_export.export_collection(self.dest, "set_v001", self.entries()).report
        self.assertEqual(r["datasets"][0]["missing"], [self.a[1]])
        self.assertEqual(r["datasets"][0]["written"], 2)
        with zipfile.ZipFile(self.dest) as z:
            self.assertNotIn(f"camA/{self.a[1]}", z.namelist())

    def test_the_same_picture_name_in_two_cameras_is_kept_in_both_folders(self) -> None:
        c = write_frames("camC", (200, 200), 1, "a")  # camC's picture has the name of camA's first
        self.assertEqual(c[0], self.a[0])
        fc = freeze("camC", [(c[0], "OK")], boxed=c)
        entries = [*self.entries(), Entry("camC", fc["id"], SubFields("camC", "camC-OK", "camC-NG"))]
        built = ds_export.export_collection(self.dest, "set_v001", entries)
        with zipfile.ZipFile(self.dest) as z:
            self.assertIn(f"camA/{self.a[0]}", z.namelist())
            self.assertIn(f"camC/{c[0]}", z.namelist())
        self.assertEqual(built.report["written"], 6)
