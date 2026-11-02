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
