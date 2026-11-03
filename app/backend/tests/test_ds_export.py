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


def sub(folder: str, ok: str = "OK", ng: str = "NG", **kw) -> ds_export.SubFields:
    return ds_export.SubFields(folder, ok, ng, **kw)


def part(folder: str, names: list[tuple[str, str]], ok: str = "OK", ng: str = "NG", **kw) -> tuple[ds_export.SubFields, list[dict]]:
    pics = [{"name": n, "width": 200, "height": 200, "cls": c, "box": (10, 10, 50, 60)} for n, c in names]
    return sub(folder, ok, ng, **kw), pics


class ClassesOfTests(unittest.TestCase):
    def test_equal_names_are_one_class_across_datasets(self) -> None:
        classes, notes = ds_export.classes_of([sub("camA"), sub("camB")])
        self.assertEqual([(c["name"], c["datasets"], c["as_ok"], c["as_ng"]) for c in classes],
                         [("OK", ["camA", "camB"], ["camA", "camB"], []), ("NG", ["camA", "camB"], [], ["camA", "camB"])])
        self.assertEqual((classes[0]["id"], classes[1]["id"], notes), (ds_export.FIRST_CLASS_ID, ds_export.FIRST_CLASS_ID + 1, []))

    def test_prefixed_names_are_separate_classes(self) -> None:
        classes, notes = ds_export.classes_of([sub("camA", "camA-OK", "camA-NG"), sub("camB", "camB-OK", "camB-NG")])
        self.assertEqual([c["name"] for c in classes], ["camA-OK", "camA-NG", "camB-OK", "camB-NG"])
        self.assertEqual(len({c["id"] for c in classes}), 4)
        self.assertEqual(notes, [])

    def test_one_dataset_can_share_only_its_ok_class(self) -> None:
        classes, _ = ds_export.classes_of([sub("camA", "OK", "camA-NG"), sub("camB", "OK", "camB-NG")])
        self.assertEqual([(c["name"], c["datasets"]) for c in classes], [("OK", ["camA", "camB"]), ("camA-NG", ["camA"]), ("camB-NG", ["camB"])])

    def test_names_equal_ignoring_case_are_one_class_and_the_first_spelling_wins(self) -> None:
        classes, _ = ds_export.classes_of([sub("camA", "Good", "Bad"), sub("camB", "GOOD", "bad")])
        self.assertEqual([(c["name"], c["datasets"]) for c in classes], [("Good", ["camA", "camB"]), ("Bad", ["camA", "camB"])])

    def test_two_colours_for_one_class_are_noted_and_the_first_is_used(self) -> None:
        classes, notes = ds_export.classes_of([sub("camA", ok_color="#010203"), sub("camB", ok_color="#0a0b0c")])
        self.assertEqual(classes[0]["color"], "#010203")
        self.assertEqual(len(notes), 1)
        self.assertIn("'OK' has two colours", notes[0])
        self.assertIn("camB", notes[0])

    def test_a_class_that_is_ok_in_one_dataset_and_ng_in_another_is_noted(self) -> None:
        _, notes = ds_export.classes_of([sub("camA", "Good", "Bad"), sub("camB", "Bad", "Worse")])
        self.assertEqual(len(notes), 2)  # 'Bad' is red as NG in camA and green as OK in camB, so it has two colours as well
        self.assertTrue(any("'Bad' is the OK class of camB and the NG class of camA" in n for n in notes))
        self.assertTrue(any("'Bad' has two colours" in n for n in notes))


class BuildMultiTests(unittest.TestCase):
    """The collection as the real DS imported it on 2026-11-03 (two sub-datasets sharing one class pair): same keys, same order."""

    def two(self, **kw):
        return ds_export.build_multi("set_v001", [part("camA", [("a1", "OK"), ("a2", "NG")], **kw), part("camB", [("b1", "OK"), ("b2", "NG")], **kw)])

    def test_keys_and_their_order_are_those_of_the_single_dataset_file(self) -> None:
        c, classes, notes = self.two()
        self.assertEqual(list(c), ["Name", "Note", "NormalizedName", "AvatarImage", "Tags", "ObjectDetectionLabelDefinitions", "SegmentationLabelDefinitions",
                                   "ClassificationLabelDefinitions", "ObjectDetectionArchiveDatasets", "SegmentationArchiveDatasets", "ClassificationArchiveDatasets"])
        self.assertEqual((c["Name"], c["Note"], c["NormalizedName"]), ("set_v001", "set_v001", "SET_V001"))
        label = next(iter(c["ObjectDetectionLabelDefinitions"].values()))
        self.assertEqual(list(label), ["NodeId", "Name", "Note", "NormalizedName", "AvatarImage", "LabelDefinitionScope", "Tags", "RChannel", "GChannel", "BChannel", "DatasetNodeId"])
        for d in c["ObjectDetectionArchiveDatasets"]:
            self.assertEqual(list(d), ["Images", "NodeId", "NormalizedName", "Name", "Note", "Tags", "AvatarImage"])
            self.assertEqual(list(d["Images"][0]), ["LabelObjectDetectionBoundingBoxes", "Name", "NormalizedName", "FolderPath", "Type", "Storage", "Width", "Height"])
        self.assertEqual(notes, [])

    def test_shared_classes_have_one_definition_and_both_datasets_point_at_it(self) -> None:
        c, classes, _ = self.two()
        defs = c["ObjectDetectionLabelDefinitions"]
        self.assertEqual(sorted(l["Name"] for l in defs.values()), ["NG", "OK"])
        self.assertEqual(list(defs), [str(k["id"]) for k in classes])
        ids_of = {d["Name"]: [i["LabelObjectDetectionBoundingBoxes"][0]["LabelDefinitionNodeId"] for i in d["Images"]] for d in c["ObjectDetectionArchiveDatasets"]}
        self.assertEqual(ids_of["camA"], ids_of["camB"])
        self.assertEqual({defs[str(i)]["Name"] for i in ids_of["camA"]}, {"OK", "NG"})

    def test_separate_classes_keep_the_datasets_apart(self) -> None:
        c, _, _ = ds_export.build_multi("set_v001", [part("camA", [("a1", "OK"), ("a2", "NG")], "camA-OK", "camA-NG"), part("camB", [("b1", "OK")], "camB-OK", "camB-NG")])
        defs = c["ObjectDetectionLabelDefinitions"]
        self.assertEqual(sorted(l["Name"] for l in defs.values()), ["camA-NG", "camA-OK", "camB-NG", "camB-OK"])
        used = {d["Name"]: {defs[str(i["LabelObjectDetectionBoundingBoxes"][0]["LabelDefinitionNodeId"])]["Name"] for i in d["Images"]} for d in c["ObjectDetectionArchiveDatasets"]}
        self.assertEqual(used, {"camA": {"camA-OK", "camA-NG"}, "camB": {"camB-OK"}})

    def test_dataset_ids_are_unique_and_the_folder_path_follows_them(self) -> None:
        c, _, _ = self.two()
        datasets = c["ObjectDetectionArchiveDatasets"]
        self.assertEqual([d["NodeId"] for d in datasets], [1, 2])
        self.assertEqual([d["Images"][0]["FolderPath"] for d in datasets], ["ObjectDetectionArchiveDatasetImages/1", "ObjectDetectionArchiveDatasetImages/2"])
        self.assertEqual([(d["Name"], d["NormalizedName"], d["Note"]) for d in datasets], [("camA", "CAMA", "camA"), ("camB", "CAMB", "camB")])

    def test_boxes_are_written_like_in_the_single_file(self) -> None:
        c, _, _ = self.two()
        box = c["ObjectDetectionArchiveDatasets"][0]["Images"][0]["LabelObjectDetectionBoundingBoxes"][0]
        self.assertEqual((box["X1"], box["X2"], box["Y1"], box["Y2"]), (10, 49, 10, 59))

    def test_bad_input_is_refused_with_a_message_that_names_the_dataset(self) -> None:
        cases = (
            ([part("camA", [("a", "OK")]), part("CAMA", [("b", "OK")])], "'camA' and 'CAMA'"),
            ([part("camA", [("a", "OK")], ok="x", ng="X")], "Dataset camA: The OK and NG class names must differ"),
            ([part("camA", [("a", "OK")]), part("a/b", [("b", "OK")])], "Dataset a/b: The picture folder name"),
            ([part("camA", [("a", "OK")], ng_color="red")], "Dataset camA: NG colour"),
            ([], "at least one dataset"),
        )
        for parts, text in cases:
            with self.assertRaises(DsExportError) as ctx:
                ds_export.build_multi("set_v001", parts)
            self.assertIn(text, str(ctx.exception))
        with self.assertRaises(DsExportError) as ctx:
            ds_export.build_multi("  ", [part("camA", [("a", "OK")])])
        self.assertIn("Collection name", str(ctx.exception))

    def test_the_build_number_makes_the_collection_name_unique(self) -> None:
        self.assertEqual(ds_export.build_name(" My model ", 1), "My model_v001")
        self.assertEqual(ds_export.build_name("My model", 12), "My model_v012")


class WriteCollectionZipTests(unittest.TestCase):
    def test_every_dataset_is_a_folder_at_the_root_and_names_may_repeat_between_folders(self) -> None:
        with TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "a.jpg", Path(tmp) / "b.jpg"
            a.write_bytes(b"AAA")
            b.write_bytes(b"BBB")
            out = Path(tmp) / "out" / "set.zip"
            collection, _, _ = ds_export.build_multi("set_v001", [part("camA", [("x", "OK")]), part("camB", [("x", "NG")])])
            ds_export.write_collection_zip(out, collection, [("camA", "x.jpg", a), ("camB", "x.jpg", b)])
            with zipfile.ZipFile(out) as z:
                self.assertEqual(sorted(z.namelist()), ["camA/x.jpg", "camB/x.jpg", "datasetCollection.json"])
                self.assertEqual((z.read("camA/x.jpg"), z.read("camB/x.jpg")), (b"AAA", b"BBB"))
                self.assertEqual(json.loads(z.read("datasetCollection.json")), collection)
            self.assertEqual([p.name for p in out.parent.iterdir()], ["set.zip"])  # no temporary file is left

    def test_a_failed_write_leaves_neither_the_zip_nor_a_temporary_file(self) -> None:
        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "set.zip"
            with self.assertRaises(FileNotFoundError):
                ds_export.write_collection_zip(out, {"Name": "x"}, [("camA", "x.jpg", Path(tmp) / "missing.jpg")])
            self.assertEqual(list(Path(tmp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
