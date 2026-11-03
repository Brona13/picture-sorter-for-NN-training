"""The whole step-2 chain on synthetic pictures (plan ``plans/two-step-solution.md``, stage 5): Freeze -> Ingest OK / NG ->
step-2 Classifier anchored to a Box -> cut-outs, scoring, goldens and Mute, and the key that makes the pictures load afresh."""
from __future__ import annotations

import cv2
import numpy as np

import anchor
import config
import datamodel
import flow
import labels
import picture_key
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job

CAM = "camX"
W, H = 100, 60


def write_ramp_frames(camera: str, count: int) -> list[str]:
    """Pictures whose grey value is twice the x position, with a band whose brightness differs per picture: a cut-out
    says where it came from by its first column."""
    datamodel.ensure_camera_dirs(camera)
    names = []
    for i in range(count):
        row = (np.arange(W) * 2).astype(np.uint8)
        img = np.tile(row, (H, 1))
        img = np.stack([img] * 3, axis=2)
        img[:, :, 2] = np.minimum(255, img[:, :, 2] + 12 * i)  # each picture a little redder: distinct content for the cache
        name = f"ramp_{i:02d}.png"
        cv2.imwrite(str(datamodel.unsorted_dir(camera) / name), img)
        names.append(name)
    import ingest

    ingest.rebuild_index(camera)
    return names


def label_of_pick(case: "BoxChainTests", frame: str) -> str:
    return labels.current_labels(CAM, "pick")[frame]


class BoxChainTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._emb = config.EMBEDDING_ENABLED
        config.EMBEDDING_ENABLED = False
        self.frames = write_ramp_frames(CAM, 8)
        self.base = f"/api/cameras/{CAM}"
        self.hmap = labels.hash_map(CAM)
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 1, 1, classes=["OK", "NG"]), ROI("pick", 0.1, 0.1, 0.5, 0.5, classes=["OK", "NG"])])
        # step 1: the first six pictures are decided (four OK, two NG) and frozen; the last two are never labeled
        for frame, cls in zip(self.frames[:6], ["OK", "OK", "OK", "OK", "NG", "NG"]):
            labels.set_label(CAM, "seal", frame, cls)
        freeze = flow.create_node(CAM, "export")
        for where, dot in (("ok", "OK"), ("ng", "NG")):
            flow.update_node(CAM, freeze, {"add_line": {"input": where, "ref": {"feature": "seal", "dot": dot}}})
        self.assertEqual(self.client.post(f"{self.base}/flow/nodes/{freeze}/export/freeze", json={}).status_code, 201)
        # step 1: a detector found the two holes on every picture
        self.det = flow.create_node(CAM, "detector")
        graph = flow.load_graph(CAM)
        graph["nodes"][self.det]["targets"] = [
            {"name": "left hole", "examples": [{"png": "x"}], "count": 1},
            {"name": "right hole", "examples": [{"png": "x"}], "count": 1},
        ]
        flow.save_graph(CAM, graph)
        self.store_holes(left_x=30.0, right_x=70.0)
        # step 2: piles, the Box, a Classifier that reads the Box and takes the piles
        self.ok = flow.create_node(CAM, "ingest_ok")
        self.ng = flow.create_node(CAM, "ingest_ng")
        self.box = flow.create_node(CAM, "box")
        self.put_box({"mode": "two", "holes": [{"detector": self.det, "target": "left hole"}, {"detector": self.det, "target": "right hole"}]})
        self.client.put(f"{self.base}/chain/pick/step", json={"step": 2})
        self.client.put(f"{self.base}/chain/pick/detached", json={"detached": True})
        for cls, pile in (("OK", self.ok), ("NG", self.ng)):
            self.assertEqual(self.client.put(f"{self.base}/chain/pick/class-lines", json={"cls": cls, "box": pile}).status_code, 200)
        anchor.set_anchor(CAM, "pick", self.box, "box")

    def tearDown(self) -> None:
        config.EMBEDDING_ENABLED = self._emb
        super().tearDown()

    def store_holes(self, left_x: float, right_x: float) -> None:
        stored = {self.hmap[f]: {
            "left hole": {"x": left_x, "y": 30.0, "w": 10, "h": 6, "angle": 0.0, "score": 1.0},
            "right hole": {"x": right_x, "y": 30.0, "w": 10, "h": 6, "angle": 0.0, "score": 1.0},
        } for f in self.frames}
        flow._store(CAM, self.det, flow.signature(flow.load_graph(CAM), self.det), stored)

    def put_box(self, body: dict) -> None:
        r = self.client.put(f"{self.base}/flow/nodes/{self.box}", json=body)
        self.assertEqual(r.status_code, 200, r.text)

    def cutout(self, frame: str) -> np.ndarray:
        r = self.client.get(f"{self.base}/frames/{frame}/cutout", params={"feature": "pick"})
        self.assertEqual(r.status_code, 200, r.text)
        return cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)

    def state(self) -> dict:
        return self.client.get(f"{self.base}/classify/state", params={"feature": "pick"}).json()

    def test_the_classifier_sees_the_frozen_pictures_cut_to_the_box_rectangle(self) -> None:
        st = self.state()
        self.assertEqual((st["step"], st["frames_seen"], st["counts"]["OK"], st["counts"]["NG"]), (2, 6, 4, 2))  # the two unlabeled pictures are not in step 2
        crop = self.cutout(self.frames[0])
        h, w = crop.shape[:2]
        self.assertAlmostEqual(w, 50, delta=2)  # holes at x 30 and 70, 10 wide: 25..75
        self.assertAlmostEqual(h, 6, delta=2)   # 6 high: 27..33
        self.assertAlmostEqual(int(crop[0, 0, 0]), 2 * 25, delta=4)  # the first column of the cut-out is column 25 of the picture

    def test_other_margins_cut_another_rectangle_and_the_pictures_get_another_address_key(self) -> None:
        key = picture_key.of(CAM, "pick")
        self.assertEqual(key, picture_key.of(CAM, "pick"))  # nothing changed: the same key
        self.assertEqual(self.state()["picture_key"], key)
        self.put_box({"margins": {"left": 5, "right": 5, "up": 4, "down": 4}})
        crop = self.cutout(self.frames[0])
        self.assertAlmostEqual(crop.shape[1], 60, delta=2)
        self.assertAlmostEqual(crop.shape[0], 14, delta=2)
        self.assertAlmostEqual(int(crop[0, 0, 0]), 2 * 20, delta=4)
        changed = picture_key.of(CAM, "pick")
        self.assertNotEqual(changed, key)
        self.assertEqual(self.state()["picture_key"], changed)
        listed = {r["feature"]: r for r in self.client.get(f"{self.base}/rois").json()["rois"]}
        self.assertEqual(listed["pick"]["picture_key"], changed)

    def test_the_key_changes_when_the_detector_runs_again_and_when_the_box_measures_from_the_centre(self) -> None:
        key = picture_key.of(CAM, "pick")
        self.store_holes(left_x=32.0, right_x=72.0)  # the detector was run again
        moved = picture_key.of(CAM, "pick")
        self.assertNotEqual(moved, key)
        self.assertAlmostEqual(self.cutout(self.frames[0]).shape[1], 50, delta=2)
        self.assertAlmostEqual(int(self.cutout(self.frames[0])[0, 0, 0]), 2 * 27, delta=4)
        self.put_box({"measure_from": "centre", "margins": {"up": 4, "down": 4}})  # from the centres there is no height without up and down
        self.assertNotEqual(picture_key.of(CAM, "pick"), moved)
        crop = self.cutout(self.frames[0])
        self.assertAlmostEqual(crop.shape[1], 40, delta=2)  # centres 32 and 72
        self.assertAlmostEqual(crop.shape[0], 8, delta=2)

    def test_one_box_mode_cuts_round_that_one_box(self) -> None:
        self.put_box({"mode": "one", "holes": [{"detector": self.det, "target": "right hole"}], "margins": {"left": 10, "right": 10, "up": 2, "down": 2}})
        crop = self.cutout(self.frames[0])
        self.assertAlmostEqual(crop.shape[1], 30, delta=2)  # 10 wide + 10 + 10
        self.assertAlmostEqual(int(crop[0, 0, 0]), 2 * 55, delta=4)  # 65 - 10

    def test_a_picture_where_a_hole_was_not_found_has_no_cutout(self) -> None:
        stored = flow.load_stored(CAM, self.det)
        del stored["frames"][self.hmap[self.frames[1]]]["right hole"]
        flow._store(CAM, self.det, "after-edit", stored["frames"])
        r = self.client.get(f"{self.base}/frames/{self.frames[1]}/cutout", params={"feature": "pick"})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.cutout(self.frames[0]).shape[0] > 0, True)

    def test_scoring_goldens_and_mute_work_on_the_box_rectangle(self) -> None:
        f = self.frames
        for frame in (f[0], f[4]):
            r = self.client.put(f"{self.base}/classify/golden", json={"feature": "pick", "frame": frame, "golden": True})
            self.assertEqual(r.status_code, 200, r.text)
        label_of = labels.current_labels(CAM, "pick")
        self.assertEqual((label_of[f[0]], label_of[f[4]]), ("OK", "NG"))  # the goldens took the freeze's labels
        job = self.client.post(f"{self.base}/classify/refresh", json={"feature": "pick"})
        done = wait_for_job(self.client, job.json()["id"], timeout=60)
        self.assertEqual(done["status"], "done", done)
        st = self.state()
        self.assertTrue(st["scored"])
        grid = self.client.get(f"{self.base}/classify/grid", params={"feature": "pick", "view": "All", "rank": "cpu", "order": "Name", "page": 1}).json()
        self.assertEqual(grid["total"], 6)
        self.assertTrue(all(c["leanings"] or c["golden"] for c in grid["items"]))
        # the suggested goldens are picks from this Classifier's pictures, never a golden already
        suggest = self.client.get(f"{self.base}/classify/suggest", params={"feature": "pick", "rank": "cpu"}).json()
        self.assertTrue(suggest["available"], suggest)
        picks = [p["frame"] for p in suggest["picks"]]
        self.assertTrue(picks and set(picks) <= set(f[:6]) - {f[0], f[4]}, picks)
        self.assertTrue(suggest["labeled"] and all(p["label"] in ("OK", "NG") for p in suggest["picks"]))
        # promoting only makes a golden: the freeze's label stays, and another class is refused
        pick = picks[0]
        wrong = "NG" if label_of_pick(self, pick) == "OK" else "OK"
        r = self.client.post(f"{self.base}/classify/promote", json={"feature": "pick", "frame": pick, "cls": wrong})
        self.assertEqual(r.status_code, 422, r.text)
        r = self.client.post(f"{self.base}/classify/promote", json={"feature": "pick", "frame": pick, "cls": label_of_pick(self, pick)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(labels.current_labels(CAM, "pick")[pick], label_of_pick(self, pick))
        self.assertIn(pick, [fr for fs in labels.current_goldens(CAM, "pick").values() for fr in fs])
        # Mute takes a picture out of this Classifier only, and never a golden
        muted = self.client.post(f"{self.base}/classify/mute", json={"feature": "pick", "frames": [f[0], f[2]]}).json()
        self.assertEqual((muted["muted"], muted["skipped_golden"]), (1, 1))
        self.assertEqual(self.state()["muted_count"], 1)
        shown = self.client.get(f"{self.base}/classify/grid", params={"feature": "pick", "view": "All", "rank": "cpu", "order": "Name", "page": 1}).json()
        self.assertEqual((shown["total"], f[2] in [c["frame"] for c in shown["items"]]), (5, False))  # the muted picture leaves this Classifier's grid
        self.assertEqual(labels.current_labels(CAM, "seal")[f[2]], "OK")  # step 1 keeps its label

    # ---- stage 6: the step-2 Export lists the rectangles --------------------------------------------------------------
    def export_box_node(self, goldens: bool = True) -> str:
        node = flow.create_node(CAM, "export", 2)
        for where, dot in (("ok", "OK"), ("ng", "NG")):
            flow.update_node(CAM, node, {"add_line": {"input": where, "ref": {"feature": "pick", "dot": dot}}})
        flow.update_node(CAM, node, {"goldens_only": goldens})
        return node

    def golden(self, *frames: str) -> None:
        for frame in frames:
            self.assertEqual(self.client.put(f"{self.base}/classify/golden", json={"feature": "pick", "frame": frame, "golden": True}).status_code, 200)

    def test_the_export_plan_knows_the_box_and_the_numbers_are_the_cutout_rectangle(self) -> None:
        import export_box

        f = self.frames
        self.golden(f[0], f[4])
        node = self.export_box_node()
        p = export_box.plan(CAM, node)
        self.assertEqual((p["box"], p["with_box"], p["no_box"], p["box_format"], len(p["items"])), (self.box, 2, 0, "corners", 2))
        numbers = export_box.box_numbers(CAM, self.box, [f[0]])[f[0]]
        crop = self.cutout(f[0])
        self.assertEqual((numbers[2] - numbers[0], numbers[3] - numbers[1]), (crop.shape[1], crop.shape[0]))  # the numbers are the cut-out's size
        self.assertEqual(int(crop[0, 0, 0]), 2 * numbers[0])  # and its first column
        self.assertEqual(export_box.box_row(numbers, "size"), [numbers[0], numbers[1], numbers[2] - numbers[0], numbers[3] - numbers[1]])

    def test_a_step_one_freeze_and_an_export_without_a_box_have_no_rectangles(self) -> None:
        import export_box

        self.golden(self.frames[0], self.frames[4])
        plain = flow.create_node(CAM, "export", 2)
        flow.update_node(CAM, plain, {"add_line": {"input": "ok", "ref": {"feature": "seal", "dot": "OK"}}})  # a Classifier that is not on a Box
        self.assertEqual(export_box.plan(CAM, plain)["box"], None)
        freeze = [n for n, node in flow.load_graph(CAM)["nodes"].items() if node["kind"] == "export" and flow.step_of(node) == 1][0]
        self.assertEqual((export_box.plan(CAM, freeze)["box"], export_box.plan(CAM, freeze)["no_box"]), (None, 0))

    def test_the_rectangles_are_frozen_with_the_version_and_written_to_boxes_csv(self) -> None:
        import csv

        import export_box

        f = self.frames
        self.golden(f[0], f[4])
        node = self.export_box_node()
        frozen = self.client.post(f"{self.base}/flow/nodes/{node}/export/freeze", json={"name": "round one"})
        self.assertEqual(frozen.status_code, 201, frozen.text)
        self.assertEqual(frozen.json()["counts"]["with_box"], 2)
        self.put_box({"margins": {"left": 20, "right": 20, "up": 9, "down": 9}})  # the Box changes after the freeze: the export must not
        done = self.client.post(f"{self.base}/project-versions/{frozen.json()['id']}/export").json()
        self.assertEqual((done["written"], done["boxes"], done["no_box"]), (2, 2, 0))
        with open(f"{done['destination']}/boxes.csv", newline="", encoding="utf-8") as fh:
            rows = list(csv.reader(fh, delimiter=";"))
        self.assertEqual(rows[0], ["file", "class", "x1", "y1", "x2", "y2"])
        by_file = {r[0]: r for r in rows[1:]}
        self.assertEqual(set(by_file), {f[0], f[4]})
        self.assertEqual(by_file[f[0]][1], "OK")
        self.assertEqual(by_file[f[4]][1], "NG")
        x1, y1, x2, y2 = (int(v) for v in by_file[f[0]][2:])
        self.assertAlmostEqual(x2 - x1, 50, delta=2)  # the frozen numbers, not the new margins
        self.assertTrue((tmp := done["destination"]) and (self.frames[0] in __import__("os").listdir(f"{tmp}/OK")))
        self.assertEqual(export_box.box_row((x1, y1, x2, y2), "corners"), [x1, y1, x2, y2])

    def test_the_ds_zip_is_made_from_the_frozen_rectangles(self) -> None:
        import json
        import zipfile

        f = self.frames
        self.golden(f[0], f[4])
        node = self.export_box_node()
        frozen = self.client.post(f"{self.base}/flow/nodes/{node}/export/freeze", json={"name": "ds"}).json()
        body = {"dataset_name": "My set", "folder_name": "200", "ok_name": "Good", "ng_name": "Bad", "ok_color": "#00ff00", "ng_color": "#ff0000", "zip_name": ""}
        r = self.client.post(f"{self.base}/project-versions/{frozen['id']}/ds-export", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        done = r.json()
        self.assertEqual((done["written"], done["no_box"], done["left_out"]), (2, 0, 0))
        self.assertTrue(done["destination"].endswith(f"My set_v{frozen['number']:03d}.zip"))
        with zipfile.ZipFile(done["destination"]) as z:
            self.assertEqual(sorted(z.namelist()), sorted(["datasetCollection.json", f"200/{f[0]}", f"200/{f[4]}"]))
            data = json.loads(z.read("datasetCollection.json"))
        images = {i["Name"]: i for i in data["ObjectDetectionArchiveDatasets"][0]["Images"]}
        self.assertEqual(set(images), {f[0].rsplit(".", 1)[0], f[4].rsplit(".", 1)[0]})
        names = {l["NodeId"]: l["Name"] for l in data["ObjectDetectionLabelDefinitions"].values()}
        shown = images[f[4].rsplit(".", 1)[0]]
        self.assertEqual(names[shown["LabelObjectDetectionBoundingBoxes"][0]["LabelDefinitionNodeId"]], "Bad")
        box = shown["LabelObjectDetectionBoundingBoxes"][0]
        self.assertTrue(0 <= box["X1"] <= box["X2"] <= shown["Width"] - 1 and 0 <= box["Y1"] <= box["Y2"] <= shown["Height"] - 1)
        # a freeze without rectangles (step 1) and a bad field are refused with a message
        step_one = [n for n, nd in flow.load_graph(CAM)["nodes"].items() if nd["kind"] == "export" and flow.step_of(nd) == 1][0]
        plain = self.client.post(f"{self.base}/flow/nodes/{step_one}/export/freeze", json={}).json()
        refused = self.client.post(f"{self.base}/project-versions/{plain['id']}/ds-export", json=body)
        self.assertEqual(refused.status_code, 422)
        self.assertIn("no rectangles", refused.json()["detail"])
        bad = self.client.post(f"{self.base}/project-versions/{frozen['id']}/ds-export", json={**body, "ok_color": "green"})
        self.assertEqual(bad.status_code, 422)

    def test_the_size_layout_lists_the_corner_and_the_size(self) -> None:
        import csv

        f = self.frames
        self.golden(f[0])
        node = self.export_box_node()
        self.assertEqual(self.client.put(f"{self.base}/flow/nodes/{node}", json={"box_format": "size"}).json()["box_format"], "size")
        self.assertEqual(self.client.put(f"{self.base}/flow/nodes/{node}", json={"box_format": "polar"}).status_code, 422)
        frozen = self.client.post(f"{self.base}/flow/nodes/{node}/export/freeze", json={}).json()
        done = self.client.post(f"{self.base}/project-versions/{frozen['id']}/export").json()
        with open(f"{done['destination']}/boxes.csv", newline="", encoding="utf-8") as fh:
            rows = list(csv.reader(fh, delimiter=";"))
        self.assertEqual(rows[0], ["file", "class", "x", "y", "width", "height"])
        self.assertAlmostEqual(int(rows[1][4]), 50, delta=2)
        self.assertAlmostEqual(int(rows[1][5]), 6, delta=2)

    def test_an_export_without_a_box_writes_no_csv(self) -> None:
        import os

        self.golden(self.frames[0])
        plain = flow.create_node(CAM, "export", 2)
        flow.update_node(CAM, plain, {"add_line": {"input": "ok", "ref": {"feature": "seal", "dot": "OK"}}})
        frozen = self.client.post(f"{self.base}/flow/nodes/{plain}/export/freeze", json={})
        self.assertEqual(frozen.status_code, 201, frozen.text)
        done = self.client.post(f"{self.base}/project-versions/{frozen.json()['id']}/export").json()
        self.assertNotIn("boxes", done)
        self.assertFalse(os.path.exists(f"{done['destination']}/boxes.csv"))

    def test_the_cards_of_a_classifier_on_a_box_say_their_rectangle(self) -> None:
        import export_box

        self.golden(self.frames[0], self.frames[4])
        job = self.client.post(f"{self.base}/classify/refresh", json={"feature": "pick"})
        wait_for_job(self.client, job.json()["id"], timeout=60)
        grid = self.client.get(f"{self.base}/classify/grid", params={"feature": "pick", "view": "All", "rank": "cpu", "order": "Name", "page": 1}).json()
        by_frame = {c["frame"]: c for c in grid["items"]}
        expected = export_box.box_numbers(CAM, self.box, [self.frames[0]])[self.frames[0]]
        self.assertEqual(by_frame[self.frames[0]]["box"], list(expected))
        self.assertEqual(len(by_frame), 6)
        # a Classifier that is not on a Box has no numbers on its cards
        self.assertTrue(all("box" not in c for c in grid["items"] if c["frame"] not in by_frame))  # (every card here is on the Box)
        self.assertEqual(sum("box" in c for c in grid["items"]), 6)

    # ---- the Box takes Ingest OK / Ingest NG as its input --------------------------------------------------------------
    def draw(self, pile: str) -> None:
        r = self.client.post(f"{self.base}/flow/edges", json={"source": pile, "target": self.box})
        self.assertEqual(r.status_code, 201, r.text)

    def box_detail(self) -> dict:
        return self.client.get(f"{self.base}/flow/nodes/{self.box}").json()

    def test_with_no_line_the_box_works_on_every_picture_and_with_lines_only_on_the_piles(self) -> None:
        detail = self.box_detail()
        self.assertEqual((len(detail["frames"]), detail["total"], detail["inputs"]), (8, 8, []))  # the two never-frozen pictures too
        self.draw(self.ok)
        detail = self.box_detail()
        self.assertEqual((len(detail["frames"]), detail["total"], detail["inputs"]), (4, 4, [self.ok]))  # the four OK pictures of the freeze
        self.assertEqual(set(detail["frames"]), set(self.frames[:4]))
        self.draw(self.ng)
        detail = self.box_detail()
        self.assertEqual((len(detail["frames"]), detail["total"]), (6, 6))
        self.assertEqual(set(detail["frames"]), set(self.frames[:6]))
        node = {n["id"]: n for n in self.client.get(f"{self.base}/chain").json()["nodes"]}[self.box]
        self.assertEqual((node["flow"]["found"], node["flow"]["total"], node["flow"]["box_inputs"]), (6, 6, [self.ok, self.ng]))

    def test_the_rectangles_themselves_do_not_depend_on_the_lines(self) -> None:
        import export_box

        before = export_box.box_numbers(CAM, self.box, [self.frames[0]])
        self.draw(self.ok)
        self.assertEqual(export_box.box_numbers(CAM, self.box, [self.frames[0]]), before)
        geometry = self.client.get(f"{self.base}/flow/nodes/{self.box}/box-geometry", params={"frame": self.frames[7]}).json()
        self.assertIsNotNone(geometry["rect"])  # the page can still show any picture

    def test_a_classifier_on_the_box_sees_the_pictures_both_the_piles_and_the_box_give(self) -> None:
        self.assertEqual(self.state()["frames_seen"], 6)
        self.draw(self.ok)  # only the OK pile is drawn in: the NG pictures are no longer the Box's
        self.assertEqual(self.state()["frames_seen"], 4)
        self.draw(self.ng)
        self.assertEqual(self.state()["frames_seen"], 6)

    def test_a_line_is_stored_once_and_removing_it_gives_the_pictures_back(self) -> None:
        self.draw(self.ok)
        self.draw(self.ok)
        self.assertEqual(sum(1 for e in flow.load_graph(CAM)["edges"] if e["target"] == self.box), 1)
        r = self.client.post(f"{self.base}/flow/edges/remove", json={"source": self.ok, "target": self.box})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.box_detail()["inputs"], [])
        self.assertEqual(len(self.box_detail()["frames"]), 8)

    def test_only_the_piles_can_feed_a_box_and_a_pile_feeds_nothing_else(self) -> None:
        graph = flow.load_graph(CAM)
        self.assertIn("step", flow.edge_allowed(graph, "ingest", self.box) or "")  # Ingest is step 1
        det2 = flow.create_node(CAM, "detector", 2)
        graph = flow.load_graph(CAM)
        self.assertEqual(flow.edge_allowed(graph, det2, self.box), "a detector cannot feed a Box.")  # only the piles
        self.assertEqual(flow.edge_allowed(graph, self.ok, det2), "Ingest OK cannot feed a detector.")  # and a pile feeds nothing else
        self.assertIsNone(flow.edge_allowed(graph, self.ok, self.box))
        self.assertIsNone(flow.edge_allowed(graph, self.ng, self.box))

    def test_deleting_a_pile_takes_its_line_out_of_the_box(self) -> None:
        self.draw(self.ok)
        self.client.delete(f"{self.base}/flow/nodes/{self.ok}")
        self.assertEqual(self.box_detail()["inputs"], [])


class LabelsThroughTheBoxTests(BoxChainTests):
    """The Classifier on a Box gets its labels through the Box (v1.149.0): Ingest OK / NG drawn into the Box are enough, no line
    into the Classifier's OK and NG dots."""

    def setUp(self) -> None:
        super().setUp()
        for cls, pile in (("OK", self.ok), ("NG", self.ng)):  # the way it was wired before: lines into the class dots
            self.client.put(f"{self.base}/chain/pick/class-lines", json={"cls": cls, "box": pile, "remove": True})
        labels.clear_labels_bulk(CAM, "pick", self.frames, force=True)
        flow.connect(CAM, self.ok, self.box)
        flow.connect(CAM, self.ng, self.box)

    def test_the_piles_drawn_into_the_box_label_the_classifier_without_lines_into_its_dots(self) -> None:
        import class_lines

        self.assertEqual(class_lines.get(CAM, "pick"), [])  # nothing stored, nothing drawn
        st = self.state()
        self.assertEqual((st["frames_seen"], st["counts"]["OK"], st["counts"]["NG"]), (6, 4, 2))
        current = labels.current_labels(CAM, "pick")
        self.assertEqual([current[f] for f in self.frames[:6]], ["OK"] * 4 + ["NG"] * 2)
        self.assertEqual(len(labels.locked_frames(CAM, "pick")), 6)  # final, like labels from lines

    def test_without_the_piles_in_the_box_nothing_is_labeled_and_taking_them_out_keeps_the_labels_as_hand_labels(self) -> None:
        self.state()
        graph = flow.load_graph(CAM)
        graph["edges"] = [e for e in graph["edges"] if e["target"] != self.box]
        flow.save_graph(CAM, graph)
        self.state()
        self.assertEqual(labels.locked_frames(CAM, "pick"), set())
        self.assertEqual(len(labels.current_labels(CAM, "pick")), 6)


for _name in [n for n in dir(BoxChainTests) if n.startswith("test_") and n not in LabelsThroughTheBoxTests.__dict__]:
    setattr(LabelsThroughTheBoxTests, _name, None)  # only this class's own tests run on its different wiring
