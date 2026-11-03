"""The DS import file: the 7-picture sample of a real DS export (handover ``ds-json-writer-handover.md``), rebuilt by the pure
functions and compared with it key by key, in order, with the types."""
from __future__ import annotations

import json
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

import ds_assets
import ds_export
from ds_export import DsExportError, Fields

# Edges as this app holds them (the end is exclusive): the sample's DS numbers + 1 on X2 / Y2.
SAMPLE = [
    ("a", "NG", (102, 72, 200, 200)),
    ("b", "NG", (131, 109, 195, 196)),
    ("c", "NG", (17, 25, 65, 180)),
    ("d", "OK", (9, 6, 190, 193)),
    ("e", "NG", (136, 133, 199, 195)),
    ("f", "OK", (7, 4, 80, 81)),
    ("g", "OK", None),
]


def pictures() -> list[dict]:
    return [{"name": n, "width": 200, "height": 200, "cls": c, "box": b} for n, c, b in SAMPLE]


def fields(**kw) -> Fields:
    return Fields(**{"dataset_name": "200_M13_podvozek_test_V02", "folder_name": "200", **kw}).cleaned()


class BuildCollectionTests(unittest.TestCase):
    def test_keys_and_their_order_are_those_of_a_real_export(self) -> None:
        c = ds_export.build_collection(fields(include_without_box=True), pictures())
        self.assertEqual(list(c), ["Name", "Note", "NormalizedName", "AvatarImage", "Tags", "ObjectDetectionLabelDefinitions", "SegmentationLabelDefinitions",
                                   "ClassificationLabelDefinitions", "ObjectDetectionArchiveDatasets", "SegmentationArchiveDatasets", "ClassificationArchiveDatasets"])
        self.assertEqual((c["Name"], c["NormalizedName"], c["AvatarImage"]), ("200_M13_podvozek_test_V02", "200_M13_PODVOZEK_TEST_V02", ds_assets.AVATAR_PNG))
        label = next(iter(c["ObjectDetectionLabelDefinitions"].values()))
        self.assertEqual(list(label), ["NodeId", "Name", "Note", "NormalizedName", "AvatarImage", "LabelDefinitionScope", "Tags", "RChannel", "GChannel", "BChannel", "DatasetNodeId"])
        self.assertEqual((label["LabelDefinitionScope"], label["DatasetNodeId"]), (1, None))
        ds = c["ObjectDetectionArchiveDatasets"][0]
        self.assertEqual(list(ds), ["Images", "NodeId", "NormalizedName", "Name", "Note", "Tags", "AvatarImage"])
        self.assertEqual((ds["Name"], ds["AvatarImage"]), ("200", ds_assets.AVATAR_JPEG))
        image = ds["Images"][0]
        self.assertEqual(list(image), ["LabelObjectDetectionBoundingBoxes", "Name", "NormalizedName", "FolderPath", "Type", "Storage", "Width", "Height"])
        self.assertEqual((image["Type"], image["Storage"], image["NormalizedName"]), (17, 2, "A"))
        self.assertEqual(list(image["LabelObjectDetectionBoundingBoxes"][0]), ["X1", "X2", "Y1", "Y2", "LabelDefinitionNodeId"])

    def test_boxes_are_the_pixel_indices_of_the_sample(self) -> None:
        c = ds_export.build_collection(fields(include_without_box=True), pictures())
        boxes = [i["LabelObjectDetectionBoundingBoxes"] for i in c["ObjectDetectionArchiveDatasets"][0]["Images"]]
        got = [[(b["X1"], b["X2"], b["Y1"], b["Y2"]) for b in bs] for bs in boxes]
        self.assertEqual(got, [[(102, 199, 72, 199)], [(131, 194, 109, 195)], [(17, 64, 25, 179)], [(9, 189, 6, 192)], [(136, 198, 133, 194)], [(7, 79, 4, 80)], []])
        self.assertTrue(all(isinstance(v, int) for bs in boxes for b in bs for v in b.values()))

    def test_boxes_are_clamped_into_the_picture(self) -> None:
        self.assertEqual(ds_export.ds_box((-5, -5, 500, 500), 200, 100, 2), {"X1": 0, "X2": 199, "Y1": 0, "Y2": 99, "LabelDefinitionNodeId": 2})
        self.assertEqual(ds_export.ds_box((10, 10, 10, 10), 200, 200, 2), {"X1": 10, "X2": 10, "Y1": 10, "Y2": 10, "LabelDefinitionNodeId": 2})  # an empty box stays one pixel
        self.assertEqual(ds_export.ds_box((300, 300, 400, 400), 200, 200, 2)["X1"], 199)

    def test_the_size_layout_becomes_corners(self) -> None:
        self.assertEqual(ds_export.corners([10, 20, 30, 40], "size"), (10, 20, 40, 60))
        self.assertEqual(ds_export.corners([10, 20, 30, 40], "corners"), (10, 20, 30, 40))

    def test_pictures_without_a_rectangle_are_left_out_unless_asked(self) -> None:
        left = ds_export.build_collection(fields(), pictures())["ObjectDetectionArchiveDatasets"][0]["Images"]
        kept = ds_export.build_collection(fields(include_without_box=True), pictures())["ObjectDetectionArchiveDatasets"][0]["Images"]
        self.assertEqual((len(left), len(kept)), (6, 7))
        self.assertEqual(kept[-1]["LabelObjectDetectionBoundingBoxes"], [])

    def test_class_names_and_colours_are_the_fields(self) -> None:
        c = ds_export.build_collection(fields(ok_name="Good", ng_name="Bad", ok_color="#010203", ng_color="#0a0b0c"), pictures())
        by_name = {l["Name"]: l for l in c["ObjectDetectionLabelDefinitions"].values()}
        self.assertEqual((by_name["Good"]["RChannel"], by_name["Good"]["GChannel"], by_name["Good"]["BChannel"]), (1, 2, 3))
        self.assertEqual((by_name["Bad"]["RChannel"], by_name["Bad"]["NormalizedName"]), (10, "BAD"))
        ids = {i["LabelObjectDetectionBoundingBoxes"][0]["LabelDefinitionNodeId"] for i in c["ObjectDetectionArchiveDatasets"][0]["Images"] if i["LabelObjectDetectionBoundingBoxes"]}
        self.assertEqual(ids, {l["NodeId"] for l in c["ObjectDetectionLabelDefinitions"].values()})

    def test_the_default_colours_are_the_real_ones(self) -> None:
        c = ds_export.build_collection(fields(), pictures())
        by_name = {l["Name"]: (l["RChannel"], l["GChannel"], l["BChannel"]) for l in c["ObjectDetectionLabelDefinitions"].values()}
        self.assertEqual(by_name, {"NG": (244, 67, 54), "OK": (6, 229, 43)})


class FieldsTests(unittest.TestCase):
    def test_bad_fields_are_refused_with_a_message(self) -> None:
        for kw, text in (({"dataset_name": " "}, "Dataset name"), ({"folder_name": "a/b"}, "folder name"), ({"ok_name": "ng"}, "differ"), ({"ng_color": "red"}, "NG colour")):
            with self.assertRaises(DsExportError) as ctx:
                fields(**kw)
            self.assertIn(text, str(ctx.exception))

    def test_zip_name_defaults_to_the_dataset_name_and_version(self) -> None:
        self.assertEqual(ds_export.zip_file_name(fields(), 3), "200_M13_podvozek_test_V02_v003.zip")
        self.assertEqual(ds_export.zip_file_name(fields(zip_name="mine"), 3), "mine.zip")
        self.assertEqual(ds_export.zip_file_name(fields(zip_name="a/b.ZIP"), 3), "a-b.ZIP")


class WriteZipTests(unittest.TestCase):
    def test_json_and_the_folder_sit_side_by_side_at_the_root(self) -> None:
        with TemporaryDirectory() as tmp:
            pic = Path(tmp) / "x y.2.jpg"
            pic.write_bytes(b"jpegbytes")
            out = Path(tmp) / "out" / "set.zip"
            collection = ds_export.build_collection(fields(include_without_box=True), pictures())
            ds_export.write_zip(out, collection, "200", [("x y.2.jpg", pic)])
            with zipfile.ZipFile(out) as z:
                self.assertEqual(sorted(z.namelist()), ["200/x y.2.jpg", "datasetCollection.json"])
                self.assertEqual(z.read("200/x y.2.jpg"), b"jpegbytes")
                raw = z.read("datasetCollection.json").decode("utf-8")
            self.assertNotIn(", ", raw.split('"Images"')[0])  # compact, like DS
            self.assertEqual(json.loads(raw), collection)


if __name__ == "__main__":
    unittest.main()
