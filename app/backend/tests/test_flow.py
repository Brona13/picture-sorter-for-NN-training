"""Detector -> Calculate -> Tolerance boxes on the chain (see ``flow.py``). Temp roots only."""
from __future__ import annotations

import cv2

import datamodel
import flow
import ingest
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job
from tests.test_rotsearch import component, turned

CAM = "camF"
LEFT_BOX = [30, 96, 62, 48]    # left hole with the notch next to it
RIGHT_BOX = [148, 96, 62, 48]  # right hole with the triangle next to it
LEFT_HOLE = [52, 102, 36, 36]
RIGHT_HOLE = [152, 102, 36, 36]
ANGLES = [0.0, 2.0, 30.0, 358.0]


class FlowTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        picture, _, _ = component()
        datamodel.ensure_camera_dirs(CAM)
        self.names = []
        for i, angle in enumerate(ANGLES):
            name = f"part_{i}.png"
            frame = picture if angle == 0.0 else turned(picture, angle, seed=i)
            cv2.imwrite(str(datamodel.unsorted_dir(CAM) / name), frame)
            self.names.append(name)
        ingest.rebuild_index(CAM)
        self.base = f"/api/cameras/{CAM}/flow"

    def post(self, path: str, body: dict | None = None, status: int = 201) -> dict:
        r = self.client.post(f"{self.base}{path}", json=body or {})
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    def put(self, path: str, body: dict) -> dict:
        r = self.client.put(f"{self.base}{path}", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def node(self, kind: str) -> str:
        return self.post("/nodes", {"kind": kind})["id"]

    def detector(self, boxes: dict[str, list[int]], parent: str | None = None, rotate: bool = True) -> str:
        node = self.node("detector")
        for name, box in boxes.items():
            self.post(f"/nodes/{node}/targets", {"name": name})
            self.post(f"/nodes/{node}/examples", {"target": name, "frame": self.names[0], "box": box})
        self.put(f"/nodes/{node}", {"rotate": rotate})
        if parent:
            self.post("/edges", {"source": parent, "target": node})
        return node

    def run_all(self) -> None:
        job = self.post("/run", status=202)
        done = wait_for_job(self.client, job["id"])
        self.assertEqual(done["status"], "done", done)

    def chain(self) -> tuple[str, str, str, str]:
        d1 = self.detector({"A": LEFT_BOX, "B": RIGHT_BOX})
        d2 = self.detector({"A": LEFT_HOLE, "B": RIGHT_HOLE}, parent=d1, rotate=False)
        calc = self.node("calc")
        self.post("/edges", {"source": d2, "target": calc})
        tol = self.node("evaluation")
        self.post("/edges", {"source": calc, "target": tol})
        return d1, d2, calc, tol

    def test_first_detector_reads_ingest_and_appears_on_the_canvas(self) -> None:
        node = self.node("detector")
        canvas = self.client.get(f"/api/cameras/{CAM}/chain").json()
        self.assertIn(node, [n["id"] for n in canvas["nodes"]])
        self.assertIn(("ingest", node), {(e["source"], e["target"]) for e in canvas["edges"]})

    def test_later_boxes_get_no_arrow_and_a_calculate_placed_first_none(self) -> None:
        calc = self.node("calc")  # first: Calculate cannot follow Ingest
        det, other = self.node("detector"), self.node("detector")
        self.assertEqual(flow.load_graph(CAM)["edges"], [])
        self.assertEqual(flow.parent_of(flow.load_graph(CAM), det), None)
        self.assertEqual(other, "det:2")
        self.assertEqual(calc, "calc:1")

    def test_an_ingest_arrow_can_be_removed(self) -> None:
        det = self.node("detector")
        self.post("/edges/remove", {"source": "ingest", "target": det}, status=200)
        self.assertEqual(flow.load_graph(CAM)["edges"], [])
        canvas = self.client.get(f"/api/cameras/{CAM}/chain").json()
        self.assertNotIn(det, [e["target"] for e in canvas["edges"]])

    def test_calculate_points_come_from_the_lines(self) -> None:
        d1, d2, calc, _ = self.chain()  # chain(): the whole of d2 feeds Calculate
        self.run_all()
        whole = flow.calc_values(CAM, calc)
        self.assertTrue(any(v is not None for v in whole.values()))
        # the same two points drawn as two single-target lines
        self.post("/edges/remove", {"source": d2, "target": calc}, status=200)
        self.post("/edges", {"source": d2, "target": calc, "point": "A"})
        self.post("/edges", {"source": d2, "target": calc, "point": "B"})
        self.assertEqual(flow.calc_values(CAM, calc), whole)
        canvas = self.client.get(f"/api/cameras/{CAM}/chain").json()
        lines = {(e["id"], e["source_handle"]) for e in canvas["edges"] if e["target"] == calc}
        self.assertEqual(lines, {(f"{d2}->{calc}#A", "t:A"), (f"{d2}->{calc}#B", "t:B")})
        # a third point is refused; removing a line frees the place
        r = self.client.post(f"{self.base}/edges", json={"source": d1, "target": calc, "point": "A"})
        self.assertEqual(r.status_code, 422)
        self.post("/edges/remove", {"source": d2, "target": calc, "point": "B"}, status=200)
        self.post("/edges", {"source": d1, "target": calc, "point": "B"})
        self.assertEqual(sorted(flow.point_names(flow.load_graph(CAM), calc)), ["A", "B"])  # names are unique, so the plain name is the key
        self.assertEqual(len(flow.calc_points(flow.load_graph(CAM), calc)), 2)
        self.assertIsNone(flow.calc_detector(flow.load_graph(CAM), calc))  # the points come from two detectors

    def test_points_of_detectors_behind_different_crops_are_measured_on_the_whole_picture(self) -> None:
        import labels  # noqa: PLC0415

        d1, d2 = self.node("detector"), self.node("detector")
        crop = self.node("crop")
        for det in (d1, d2):
            self.post(f"/nodes/{det}/targets", {"name": "P"})
            self.post(f"/nodes/{det}/examples", {"target": "P", "frame": self.names[0], "box": LEFT_BOX})
        graph = flow.load_graph(CAM)
        graph["nodes"][crop]["rect"] = [0.25, 0.5, 0.5, 0.5]
        graph["edges"] = [{"source": crop, "target": d2}]
        flow.save_graph(CAM, graph)
        key = labels.hash_map(CAM)[self.names[0]]
        flow._store(CAM, d1, None, {key: {"P": {"x": 100.0, "y": 50.0}}})
        flow._store(CAM, d2, None, {key: {"P": {"x": 10.0, "y": 20.0}}})
        calc = self.node("calc")
        self.post("/edges", {"source": d1, "target": calc, "point": "P"})
        self.post("/edges", {"source": d2, "target": calc, "point": "P"})
        self.put(f"/nodes/{calc}", {"op": "dx"})
        self.assertEqual(sorted(flow.point_names(flow.load_graph(CAM), calc)), [f"{d1}/P", f"{d2}/P"])
        width, height = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.names[0])).shape[1::-1]
        ox, _ = flow.rect_offset([[0.25, 0.5, 0.5, 0.5]], width, height)
        self.assertAlmostEqual(flow.calc_values(CAM, calc)[key], (10.0 + ox) - 100.0)

    def test_typed_arrows_are_checked(self) -> None:
        d, c, t = self.node("detector"), self.node("calc"), self.node("evaluation")
        for source, target in ((t, c), (d, t), (c, d), ("ingest", c), (d, d)):
            r = self.client.post(f"{self.base}/edges", json={"source": source, "target": target})
            self.assertEqual(r.status_code, 422, (source, target))
        self.post("/edges", {"source": d, "target": c})
        self.post("/edges", {"source": c, "target": t})

    def test_detector_loop_is_refused(self) -> None:
        a, b = self.node("detector"), self.node("detector")
        self.post("/edges", {"source": a, "target": b})
        r = self.client.post(f"{self.base}/edges", json={"source": b, "target": a})
        self.assertEqual(r.status_code, 422)

    def test_cascade_measures_the_angle_a_to_b_and_tolerance_wraps(self) -> None:
        d1, d2, calc, tol = self.chain()
        self.put(f"/nodes/{calc}", {"op": "angle", "clockwise": False})
        self.run_all()
        values = self.client.get(f"{self.base}/nodes/{calc}/values").json()["values"]
        for name, angle in zip(self.names, ANGLES):
            expected = angle % 360
            self.assertLess(abs((values[name] - expected + 180) % 360 - 180), 1.0, (name, values[name]))
        # Clockwise on screen flips the direction.
        self.put(f"/nodes/{calc}", {"clockwise": True})
        values = self.client.get(f"{self.base}/nodes/{calc}/values").json()["values"]
        self.assertLess(abs((values[self.names[2]] - 330.0 + 180) % 360 - 180), 1.0)
        self.put(f"/nodes/{calc}", {"clockwise": False})
        # Nominal 0 +- 3: 0, 2 and 358 (wrap-around) pass; 30 fails.
        self.put(f"/nodes/{tol}", {"nominal": 0.0, "tolerance": 3.0})
        state = self.client.get(f"{self.base}/nodes/{tol}/values").json()
        self.assertEqual([state["verdicts"][n] for n in self.names], ["pass", "pass", "fail", "pass"])
        self.assertEqual(state["counts"], {"pass": 3, "fail": 1, "undetermined": 0})
        self.assertEqual(len(state["histogram"]["bins"]), flow.HISTOGRAM_BINS)

    def test_no_nominal_means_undetermined(self) -> None:
        _, _, _, tol = self.chain()
        self.run_all()
        state = self.client.get(f"{self.base}/nodes/{tol}/values").json()
        self.assertEqual(state["counts"]["undetermined"], len(ANGLES))

    def test_second_detector_needs_the_first_to_have_run(self) -> None:
        d1 = self.detector({"A": LEFT_BOX})
        d2 = self.detector({"A": LEFT_HOLE}, parent=d1, rotate=False)
        r = self.client.post(f"{self.base}/nodes/{d2}/run")
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "error")

    def test_changed_example_makes_results_stale_and_human_boxes_survive(self) -> None:
        d1 = self.detector({"A": LEFT_BOX})
        self.run_all()
        self.assertEqual(self.client.get(f"{self.base}/nodes/{d1}").json()["status"], "fresh")
        r = self.client.put(f"{self.base}/nodes/{d1}/box", json={"frame": self.names[1], "target": "A", "x": 10.0, "y": 11.0})
        self.assertEqual(r.status_code, 200, r.text)
        self.run_all()
        boxes = self.client.get(f"{self.base}/nodes/{d1}/boxes").json()["boxes"]
        self.assertEqual((boxes[self.names[1]]["A"]["x"], boxes[self.names[1]]["A"]["source"]), (10.0, "human"))
        self.post(f"/nodes/{d1}/examples", {"target": "A", "frame": self.names[0], "box": RIGHT_BOX})
        self.assertEqual(self.client.get(f"{self.base}/nodes/{d1}").json()["status"], "stale")

    def test_example_rectangle_can_be_moved_and_resized_and_makes_results_stale(self) -> None:
        d1 = self.detector({"A": LEFT_BOX})
        self.run_all()
        self.assertEqual(self.client.get(f"{self.base}/nodes/{d1}").json()["status"], "fresh")
        before = self.client.get(f"{self.base}/nodes/{d1}").json()["targets"][0]["examples"][0]
        r = self.client.put(f"{self.base}/nodes/{d1}/examples/A/0", json={"box": [28, 94, 70, 52]})
        self.assertEqual(r.status_code, 200, r.text)
        after = r.json()["targets"][0]["examples"][0]
        self.assertEqual(after["box"], [28, 94, 70, 52])
        self.assertEqual(after["frame"], before["frame"])
        self.assertNotEqual(after["png"], before["png"])
        self.assertEqual(r.json()["status"], "stale")
        for bad in ([0, 0, 2, 2], [500, 500, 40, 40]):  # too small; entirely outside the picture
            self.assertEqual(self.client.put(f"{self.base}/nodes/{d1}/examples/A/0", json={"box": bad}).status_code, 422)
        self.assertEqual(self.client.put(f"{self.base}/nodes/{d1}/examples/A/5", json={"box": LEFT_BOX}).status_code, 422)

    def test_one_hole_found_goes_to_review(self) -> None:
        d1 = self.detector({"A": LEFT_BOX})
        self.post(f"/nodes/{d1}/targets", {"name": "B"})
        self.post(f"/nodes/{d1}/examples", {"target": "B", "frame": self.names[0], "box": RIGHT_BOX})
        self.run_all()
        node = self.client.get(f"{self.base}/nodes/{d1}").json()
        self.assertEqual(node["summary"]["found"]["A"], len(ANGLES))
        # Take one box away from the stored results of one frame.
        stored = flow.load_stored(CAM, d1)
        key = next(iter(stored["frames"]))
        del stored["frames"][key]["B"]
        flow._store(CAM, d1, stored["sig"], stored["frames"])
        review = self.client.get(f"{self.base}/nodes/{d1}/boxes?only_review=true").json()
        self.assertEqual(len(review["review"]), 1)

    def test_opinions_reach_the_features_classify_box(self) -> None:
        datamodel.save_rois(CAM, [ROI("part", 0, 0, 1, 1)])
        _, _, calc, tol = self.chain()
        self.put(f"/nodes/{tol}", {"nominal": 0.0, "tolerance": 3.0})
        self.post("/edges", {"source": tol, "target": "classify:part"})
        self.run_all()
        opinions = self.client.get(f"{self.base}/opinions/part").json()
        self.assertEqual(opinions["boxes"][0]["counts"], {"pass": 3, "fail": 1, "undetermined": 0})
        canvas = self.client.get(f"/api/cameras/{CAM}/chain").json()
        self.assertIn((tol, "classify:part"), {(e["source"], e["target"]) for e in canvas["edges"]})
        state = self.client.get(f"/api/cameras/{CAM}/classify/state", params={"feature": "part"}).json()
        self.assertIn("Measurement: fail", state["views"])
        # Deleting the ROI forgets the arrow.
        self.client.delete(f"/api/cameras/{CAM}/rois/part")
        self.assertNotIn((tol, "classify:part"), {(e["source"], e["target"]) for e in flow.load_graph(CAM)["edges"]})

    def test_delete_removes_box_arrows_and_results(self) -> None:
        d1, d2, calc, tol = self.chain()
        self.run_all()
        preview = self.client.get(f"{self.base}/nodes/{d1}/delete-preview").json()
        self.assertEqual(preview["detections"], len(ANGLES))
        self.client.delete(f"{self.base}/nodes/{d1}")
        graph = flow.load_graph(CAM)
        self.assertNotIn(d1, graph["nodes"])
        self.assertEqual(flow.load_stored(CAM, d1)["frames"], {})
        self.assertNotIn("ingest", {e["source"] for e in graph["edges"] if e["target"] == d2})  # what it fed reads the whole picture
        self.assertIsNone(flow.parent_of(graph, d2))

    def test_compute_conventions(self) -> None:
        self.assertAlmostEqual(flow.compute("angle", (0, 0), (10, 0)), 0.0)
        self.assertAlmostEqual(flow.compute("angle", (0, 0), (0, -10)), 90.0)   # up on screen = counter-clockwise
        self.assertAlmostEqual(flow.compute("angle", (0, 0), (0, -10), clockwise=True), 270.0)
        self.assertAlmostEqual(flow.compute("distance", (0, 0), (3, 4)), 5.0)
        self.assertAlmostEqual(flow.deviation(359.0, 1.0, True), -2.0)

    def test_bad_settings_are_refused(self) -> None:
        tol = self.node("evaluation")
        r = self.client.put(f"{self.base}/nodes/{tol}", json={"tolerance": 0})
        self.assertEqual(r.status_code, 422)

    def test_anchored_roi_follows_the_detected_box_and_keeps_the_static_one_otherwise(self) -> None:
        import anchor
        import engine
        import labels

        d1 = self.detector({"A": LEFT_BOX})
        self.run_all()
        height, width = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.names[0])).shape[:2]
        datamodel.save_rois(CAM, [ROI("part", 0.1, 0.2, 0.2, 0.2), ROI("plain", 0.0, 0.0, 0.5, 0.5)])
        spec = anchor.set_anchor(CAM, "part", d1, "A", self.names[0], mode="rect", follow_rotation=False, image_size=(width, height))
        hashes = labels.hash_map(CAM)
        stored = flow.load_stored(CAM, d1)["frames"]
        for name in self.names:
            key = hashes[name]
            placed = engine.resolve_roi_for_frame(CAM, "part", key, width, height)
            entry = stored[key]["A"]
            self.assertAlmostEqual((placed.x + placed.w / 2) * width, entry["x"] + spec["dx"], delta=0.6)
            self.assertAlmostEqual((placed.y + placed.h / 2) * height, entry["y"] + spec["dy"], delta=0.6)
        # a picture without a box has no rectangle; a plain ROI is unaffected
        key = hashes[self.names[1]]
        flow._store(CAM, d1, flow.load_stored(CAM, d1)["sig"], {k: ({} if k == key else v) for k, v in stored.items()})
        self.assertIsNone(engine.resolve_roi_for_frame(CAM, "part", key, width, height))
        self.assertEqual(engine.resolve_roi_for_frame(CAM, "plain", key, width, height).w, 0.5)
        with self.assertRaises(anchor.AnchorError):
            anchor.set_anchor(CAM, "part", d1, "A", self.names[1], mode="rect", image_size=(width, height))

    def test_vectors_of_an_anchored_roi_follow_the_box_and_skip_pictures_without_one(self) -> None:
        import anchor
        import classify
        import db
        import labels

        d1 = self.detector({"A": LEFT_BOX})
        self.run_all()
        height, width = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.names[0])).shape[:2]
        datamodel.save_rois(CAM, [ROI("part", 0.1, 0.2, 0.2, 0.2)])
        anchor.set_anchor(CAM, "part", d1, "A", self.names[0], mode="rect", image_size=(width, height))
        hmap = labels.hash_map(CAM)
        stored = flow.load_stored(CAM, d1)
        gone = hmap[self.names[1]]
        flow._store(CAM, d1, stored["sig"], {k: ({} if k == gone else v) for k, v in stored["frames"].items()})
        roi = datamodel.get_roi(CAM, "part")
        con = db.connect()
        try:
            key = classify._roi_cache_key(roi, CAM, "part", con)
            self.assertIn("anchor:", key)
            vectors = classify.fetch_vectors(con, CAM, "part", key, roi, self.names, hmap, [])
        finally:
            con.close()
        self.assertEqual(sorted(vectors), sorted(n for n in self.names if n != self.names[1]))
        # a re-run that moves the box changes the rule key (the detector signature), so old vectors are not reused
        self.put(f"/nodes/{d1}", {"pad": 0.5})
        self.assertNotEqual(key, classify._roi_cache_key(roi, CAM, "part"))

    def test_thumbnail_of_an_anchored_roi_is_cut_where_the_box_is(self) -> None:
        import anchor

        d1 = self.detector({"A": LEFT_BOX})
        self.run_all()
        height, width = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.names[0])).shape[:2]
        datamodel.save_rois(CAM, [ROI("part", 0.1, 0.2, 0.2, 0.2)])
        anchor.set_anchor(CAM, "part", d1, "A", self.names[0], mode="rect", image_size=(width, height))
        url = f"/api/cameras/{CAM}/frames/{self.names[0]}/thumb?feature=part"
        ok = self.client.get(url)
        self.assertEqual(ok.status_code, 200)
        etags = {self.client.get(f"/api/cameras/{CAM}/frames/{n}/thumb?feature=part").headers["etag"] for n in self.names}
        self.assertGreater(len(etags), 1)  # the cut differs per picture
        flow._store(CAM, d1, flow.load_stored(CAM, d1)["sig"], {})
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_anchor_endpoints_chain_arrow_and_cleanup(self) -> None:
        d1 = self.detector({"A": LEFT_BOX})
        self.run_all()
        datamodel.save_rois(CAM, [ROI("part", 0.1, 0.2, 0.2, 0.2)])
        roi_url = f"/api/cameras/{CAM}/rois/part/anchor"
        bad = self.client.put(roi_url, json={"detector": d1, "target": "nope", "frame": self.names[0]})
        self.assertEqual(bad.status_code, 422)
        ok = self.client.put(roi_url, json={"detector": d1, "target": "A", "frame": self.names[0], "follow_rotation": True})
        self.assertEqual(ok.status_code, 200, ok.text)
        canvas = self.client.get(f"/api/cameras/{CAM}/chain").json()
        pairs = {(e["source"], e["target"]) for e in canvas["edges"]}
        self.assertIn((d1, "roi:part"), pairs)
        self.assertNotIn(("ingest", "roi:part"), pairs)
        node = next(n for n in canvas["nodes"] if n["id"] == "roi:part")
        self.assertEqual(node["anchor"]["target"], "A")
        # removing the anchor, and deleting the detector, both make the ROI static again
        self.assertEqual(self.client.delete(roi_url).status_code, 200)
        self.assertIsNone(self.client.get(f"/api/cameras/{CAM}/chain").json()["nodes"][1]["anchor"])
        self.client.put(roi_url, json={"detector": d1, "target": "A", "frame": self.names[0]})
        self.assertEqual(self.client.delete(f"{self.base}/nodes/{d1}").status_code, 200)
        import anchor

        self.assertIsNone(anchor.get_anchor(CAM, "part"))

    def test_rect_endpoint_gives_the_static_or_the_anchored_rectangle(self) -> None:
        d1 = self.detector({"A": LEFT_BOX})
        self.run_all()
        datamodel.save_rois(CAM, [ROI("part", 0.1, 0.2, 0.2, 0.2)])
        url = f"/api/cameras/{CAM}/rois/part/rect?frame={self.names[0]}"
        plain = self.client.get(url).json()
        self.assertEqual((plain["anchored"], plain["rect"]["x"]), (False, 0.1))
        self.client.put(f"/api/cameras/{CAM}/rois/part/anchor", json={"detector": d1, "target": "A", "frame": self.names[0]})
        self.assertAlmostEqual(self.client.get(url).json()["rect"]["x"], 0.1, places=2)
        other = self.client.get(f"/api/cameras/{CAM}/rois/part/rect?frame={self.names[2]}").json()
        self.assertTrue(other["anchored"])
        self.assertNotAlmostEqual(other["rect"]["x"], 0.1, places=3)
        self.assertTrue(any(r["anchored"] for r in self.client.get(f"/api/cameras/{CAM}/rois").json()["rois"]))

    def test_old_tolerance_boxes_become_evaluation_boxes_with_arrows_and_layout(self) -> None:
        import db
        import json

        graph = {"nodes": {"calc:1": {"kind": "calc", "op": "angle", "a": None, "b": None, "clockwise": False},
                           "tol:1": {"kind": "tolerance", "nominal": 175.0, "tolerance": 3.0}},
                 "edges": [{"source": "calc:1", "target": "tol:1"}, {"source": "tol:1", "target": "classify:part"}]}
        db.set_setting(CAM, "flow.graph", json.dumps(graph))
        db.set_setting(CAM, "chain.canvas", json.dumps({"nodes": {"tol:1": {"x": 5.0, "y": 6.0, "label": "mine"}}, "viewport": None}))
        canvas = self.client.get(f"/api/cameras/{CAM}/chain").json()
        box = next(n for n in canvas["nodes"] if n["id"] == "eval:1")
        self.assertEqual((box["kind"], box["x"], box["y"], box["label"]), ("evaluation", 5.0, 6.0, "mine"))
        migrated = flow.load_graph(CAM)
        self.assertEqual(migrated["nodes"]["eval:1"]["nominal"], 175.0)
        self.assertEqual(migrated["nodes"]["eval:1"]["tolerance"], 3.0)
        self.assertIn({"source": "calc:1", "target": "eval:1"}, migrated["edges"])
        self.assertIn({"source": "eval:1", "target": "classify:part"}, migrated["edges"])

    def _crop(self, pixels: list[int]) -> tuple[str, int, int]:
        height, width = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.names[0])).shape[:2]
        crop = self.node("crop")
        x, y, w, h = pixels
        self.put(f"/nodes/{crop}", {"rect": [x / width, y / height, w / width, h / height]})
        return crop, width, height

    def test_crop_arrows_are_typed_and_only_the_first_box_reads_ingest(self) -> None:
        crop, other, det = self.node("crop"), self.node("crop"), self.node("detector")
        self.assertIn({"source": "ingest", "target": crop}, flow.load_graph(CAM)["edges"])
        self.assertEqual(flow.parent_of(flow.load_graph(CAM), other), None)
        self.post("/edges", {"source": crop, "target": other})
        self.post("/edges", {"source": other, "target": det})
        self.assertEqual(flow.parent_of(flow.load_graph(CAM), det), other)
        for source, target in ((det, crop), (other, crop), ("ingest", "calc:9")):
            self.assertEqual(self.client.post(f"{self.base}/edges", json={"source": source, "target": target}).status_code, 422, (source, target))
        # taking a Crop out leaves what it fed unconnected (it then reads the whole picture)
        self.assertEqual(self.client.delete(f"{self.base}/nodes/{other}").status_code, 200)
        self.assertIsNone(flow.parent_of(flow.load_graph(CAM), det))
        bad = self.client.put(f"{self.base}/nodes/{crop}", json={"rect": [0.5, 0.5, 0.8, 0.2]})
        self.assertEqual(bad.status_code, 422)

    def test_picture_endpoint_serves_the_cropped_input_and_output(self) -> None:
        crop, width, height = self._crop([20, 40, 150, 100])
        det = self.node("detector")
        self.post("/edges", {"source": crop, "target": det})
        out = self.client.get(f"{self.base}/nodes/{crop}/picture", params={"frame": self.names[0], "stage": "output"})
        self.assertEqual(out.status_code, 200)
        data = cv2.imdecode(__import__("numpy").frombuffer(out.content, "uint8"), cv2.IMREAD_COLOR)
        self.assertEqual(data.shape[:2], (100, 150))
        whole = self.client.get(f"{self.base}/nodes/{crop}/picture", params={"frame": self.names[0]})
        self.assertEqual(cv2.imdecode(__import__("numpy").frombuffer(whole.content, "uint8"), cv2.IMREAD_COLOR).shape[:2], (height, width))
        detector_in = self.client.get(f"{self.base}/nodes/{det}/picture", params={"frame": self.names[0], "size": 64})
        self.assertEqual(detector_in.headers["content-type"], "image/jpeg")
        self.assertEqual(len(self.node_detail(det)["crops"]), 1)

    def node_detail(self, node: str) -> dict:
        return self.client.get(f"{self.base}/nodes/{node}").json()

    def test_detector_behind_a_crop_finds_the_part_at_the_shifted_place_and_goes_stale_with_the_crop(self) -> None:
        crop, width, height = self._crop([0, 0, width_of(self), height_of(self)])
        plain = self.detector({"A": LEFT_BOX})
        self.run_all()
        key = __import__("labels").hash_map(CAM)[self.names[0]]
        full = flow.load_stored(CAM, plain)["frames"][key]["A"]
        # cut away 20 px on the left and 30 px at the top: the same part is found 20 / 30 px closer to the corner
        crop2, _, _ = self._crop([20, 30, width - 20, height - 30])
        det = self.node("detector")
        self.post("/edges", {"source": crop2, "target": det})
        self.post(f"/nodes/{det}/targets", {"name": "A"})
        self.post(f"/nodes/{det}/examples", {"target": "A", "frame": self.names[0], "box": [LEFT_BOX[0] - 20, LEFT_BOX[1] - 30, LEFT_BOX[2], LEFT_BOX[3]]})
        self.put(f"/nodes/{det}", {"rotate": False})
        self.run_all()
        found = flow.load_stored(CAM, det)["frames"][key]["A"]
        self.assertAlmostEqual(found["x"], full["x"] - 20, delta=1.0)
        self.assertAlmostEqual(found["y"], full["y"] - 30, delta=1.0)
        self.assertEqual(self.node_detail(det)["status"], "fresh")
        self.put(f"/nodes/{crop2}", {"rect": [0.1, 0.1, 0.8, 0.8]})
        self.assertEqual(self.node_detail(det)["status"], "stale")

    def test_anchored_roi_behind_a_cropped_detector_still_lies_on_the_whole_picture(self) -> None:
        import anchor
        import engine
        import labels

        crop, width, height = self._crop([20, 30, 200, 150])
        det = self.node("detector")
        self.post("/edges", {"source": crop, "target": det})
        self.post(f"/nodes/{det}/targets", {"name": "A"})
        self.post(f"/nodes/{det}/examples", {"target": "A", "frame": self.names[0], "box": [LEFT_BOX[0] - 20, LEFT_BOX[1] - 30, LEFT_BOX[2], LEFT_BOX[3]]})
        self.put(f"/nodes/{det}", {"rotate": False})
        self.run_all()
        left = [LEFT_BOX[0] / width, LEFT_BOX[1] / height, LEFT_BOX[2] / width, LEFT_BOX[3] / height]
        datamodel.save_rois(CAM, [ROI("part", *left)])
        anchor.set_anchor(CAM, "part", det, "A", self.names[0], mode="rect", image_size=(width, height))
        key = labels.hash_map(CAM)[self.names[0]]
        placed = engine.resolve_roi_for_frame(CAM, "part", key, width, height)
        self.assertAlmostEqual(placed.x * width, LEFT_BOX[0], delta=1.5)
        self.assertAlmostEqual(placed.y * height, LEFT_BOX[1], delta=1.5)

    def test_cascaded_targets_have_their_own_names_and_search_inside_the_chosen_parent_target(self) -> None:
        import labels

        d1 = self.detector({"left": LEFT_BOX, "right": RIGHT_BOX})
        d2 = self.node("detector")
        self.post("/edges", {"source": d1, "target": d2})
        for name, inside, hole in (("left detail", "left", LEFT_HOLE), ("right detail", "right", RIGHT_HOLE)):
            self.post(f"/nodes/{d2}/targets", {"name": name, "inside": inside})
            self.post(f"/nodes/{d2}/examples", {"target": name, "frame": self.names[0], "box": hole})
        self.put(f"/nodes/{d2}", {"rotate": False})
        detail = self.node_detail(d2)
        self.assertEqual([(t["name"], t["inside"]) for t in detail["targets"]], [("left detail", "left"), ("right detail", "right")])
        self.assertEqual(detail["parent_targets"], ["left", "right"])
        self.run_all()
        key = labels.hash_map(CAM)[self.names[0]]
        first = flow.load_stored(CAM, d1)["frames"][key]
        found = flow.load_stored(CAM, d2)["frames"][key]
        self.assertEqual(sorted(found), ["left detail", "right detail"])
        # each hole is found inside the box of its own parent target
        self.assertAlmostEqual(found["left detail"]["x"], LEFT_HOLE[0] + LEFT_HOLE[2] / 2, delta=1.5)
        self.assertAlmostEqual(found["right detail"]["x"], RIGHT_HOLE[0] + RIGHT_HOLE[2] / 2, delta=1.5)
        self.assertLess(abs(found["left detail"]["x"] - first["left"]["x"]), LEFT_BOX[2])
        # a Calculate box after it offers the child's own names
        calc = self.node("calc")
        self.post("/edges", {"source": d2, "target": calc})
        self.assertEqual(self.node_detail(calc)["points"], ["left detail", "right detail"])

    def test_cascaded_target_link_is_validated_changeable_and_part_of_the_signature(self) -> None:
        d1 = self.detector({"left": LEFT_BOX, "right": RIGHT_BOX})
        d2 = self.node("detector")
        self.post("/edges", {"source": d1, "target": d2})
        bad = self.client.post(f"{self.base}/nodes/{d2}/targets", json={"name": "x", "inside": "nope"})
        self.assertEqual(bad.status_code, 422)
        self.post(f"/nodes/{d2}/targets", {"name": "hole", "inside": "left"})
        self.post(f"/nodes/{d2}/examples", {"target": "hole", "frame": self.names[0], "box": LEFT_HOLE})
        before = flow.signature(flow.load_graph(CAM), d2)
        moved = self.client.put(f"{self.base}/nodes/{d2}/targets/hole", json={"inside": "right"})
        self.assertEqual(moved.status_code, 200, moved.text)
        self.assertEqual(moved.json()["targets"][0]["inside"], "right")
        self.assertNotEqual(before, flow.signature(flow.load_graph(CAM), d2))
        self.assertEqual(self.client.put(f"{self.base}/nodes/{d2}/targets/hole", json={"inside": "zzz"}).status_code, 422)
        self.assertEqual(self.client.put(f"{self.base}/nodes/{d2}/targets/none", json={"inside": "left"}).status_code, 422)
        # no link: the old rule (same name) still holds, and a first-level detector cannot have a link
        self.post(f"/nodes/{d2}/targets", {"name": "left"})
        self.assertIsNone(self.node_detail(d2)["targets"][1]["inside"])
        solo = self.node("detector")
        self.assertEqual(self.client.post(f"{self.base}/nodes/{solo}/targets", json={"name": "a", "inside": "left"}).status_code, 422)

    def test_a_picture_without_the_parent_box_is_skipped_for_the_cascaded_target(self) -> None:
        import labels

        d1 = self.detector({"left": LEFT_BOX})
        d2 = self.node("detector")
        self.post("/edges", {"source": d1, "target": d2})
        self.post(f"/nodes/{d2}/targets", {"name": "hole", "inside": "left"})
        self.post(f"/nodes/{d2}/examples", {"target": "hole", "frame": self.names[0], "box": LEFT_HOLE})
        self.put(f"/nodes/{d2}", {"rotate": False})
        self.run_all()
        gone = labels.hash_map(CAM)[self.names[1]]
        stored = flow.load_stored(CAM, d1)
        flow._store(CAM, d1, stored["sig"], {k: ({} if k == gone else v) for k, v in stored["frames"].items()})
        flow.run_detector(CAM, d2)
        self.assertNotIn("hole", flow.load_stored(CAM, d2)["frames"][gone])
        self.assertIn(self.names[1], flow.review_frames(CAM, d2))


def width_of(case: "FlowTests") -> int:
    return cv2.imread(str(datamodel.unsorted_dir(CAM) / case.names[0])).shape[1]


def height_of(case: "FlowTests") -> int:
    return cv2.imread(str(datamodel.unsorted_dir(CAM) / case.names[0])).shape[0]

    def _anchored_setup(self):
        d1 = self.detector({"A": LEFT_BOX})
        self.run_all()
        height, width = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.names[0])).shape[:2]
        datamodel.save_rois(CAM, [ROI("part", 0.1, 0.2, 0.2, 0.2)])
        return d1, width, height

    def test_box_mode_makes_the_roi_the_found_box_plus_the_margin(self) -> None:
        import anchor
        import engine
        import labels

        d1, width, height = self._anchored_setup()
        spec = anchor.set_anchor(CAM, "part", d1, "A", mode="box", margin=0.1, image_size=(width, height))
        self.assertEqual((spec["mode"], spec["margin"]), ("box", 0.1))
        stored = flow.load_stored(CAM, d1)["frames"]
        for name in self.names:
            key = labels.hash_map(CAM)[name]
            entry = stored[key]["A"]
            placed = engine.resolve_roi_for_frame(CAM, "part", key, width, height)
            import rotsearch

            x0, y0, x1, y1 = rotsearch.Match(entry["x"], entry["y"], entry["angle"], 1.0, entry["w"], entry["h"]).bbox()
            gx, gy = (x1 - x0) * 0.1, (y1 - y0) * 0.1
            x0, x1, y0, y1 = x0 + 0.5, x1 + 0.5, y0 + 0.5, y1 + 0.5  # pixel index -> pixel edge coordinates
            self.assertAlmostEqual(placed.x * width, max(0.0, x0 - gx), delta=0.01)
            self.assertAlmostEqual((placed.x + placed.w) * width, min(float(width), x1 + gx), delta=0.01)
            self.assertAlmostEqual(placed.y * height, max(0.0, y0 - gy), delta=0.01)
        self.assertEqual(self.client.put(f"/api/cameras/{CAM}/rois/part/anchor", json={"detector": d1, "target": "A", "margin": 2}).status_code, 422)
        self.assertEqual(self.client.put(f"/api/cameras/{CAM}/rois/part/anchor", json={"detector": d1, "target": "A", "mode": "x"}).status_code, 422)

    def test_rect_mode_follows_the_rois_current_rectangle_without_setting_the_anchor_again(self) -> None:
        import anchor
        import engine
        import labels

        d1, width, height = self._anchored_setup()
        anchor.set_anchor(CAM, "part", d1, "A", self.names[0], mode="rect")
        key = labels.hash_map(CAM)[self.names[0]]
        before = engine.resolve_roi_for_frame(CAM, "part", key, width, height)
        self.assertAlmostEqual(before.x, 0.1, delta=0.01)
        # the user redraws the rectangle in the ROI editor: the anchored rectangle on the exemplar picture follows at once
        datamodel.save_rois(CAM, [ROI("part", 0.4, 0.3, 0.3, 0.2)])
        after = engine.resolve_roi_for_frame(CAM, "part", key, width, height)
        self.assertAlmostEqual(after.x, 0.4, delta=0.01)
        self.assertAlmostEqual(after.w, 0.3, delta=0.01)
        self.assertNotEqual(anchor.rule_key(anchor.get_anchor(CAM, "part"), CAM), anchor.rule_key({**anchor.get_anchor(CAM, "part"), "mode": "box"}, CAM))

    def test_anchor_endpoint_gives_the_example_picture_and_the_found_box_for_the_roi_editor(self) -> None:
        d1, width, height = self._anchored_setup()
        url = f"/api/cameras/{CAM}/rois/part/anchor"
        self.assertEqual(self.client.get(url).json(), {"anchor": None, "context": None})
        self.client.put(url, json={"detector": d1, "target": "A"})
        box_mode = self.client.get(url).json()
        self.assertEqual((box_mode["anchor"]["mode"], box_mode["context"]), ("box", None))
        r = self.client.put(url, json={"detector": d1, "target": "A", "mode": "rect", "frame": self.names[0]})
        self.assertEqual(r.status_code, 200, r.text)
        got = self.client.get(url).json()
        self.assertEqual(got["context"]["frame"], self.names[0])
        box = got["context"]["box"]
        self.assertTrue(0 <= box["x"] < 1 and 0 < box["w"] <= 1)
        self.assertEqual(self.client.put(url, json={"detector": d1, "target": "A", "mode": "rect"}).status_code, 422)

    def test_an_anchor_stored_before_the_modes_existed_reads_as_rect_with_its_offsets(self) -> None:
        import anchor
        import db
        import json
        import engine
        import labels

        d1, width, height = self._anchored_setup()
        legacy = {"detector": d1, "target": "A", "follow_rotation": False, "angle0": 0.0, "dx": 10.0, "dy": -5.0, "w": 20.0, "h": 10.0}
        db.set_setting(CAM, "roi.anchor.part", json.dumps(legacy))
        self.assertEqual(anchor.get_anchor(CAM, "part")["mode"], "rect")
        key = labels.hash_map(CAM)[self.names[0]]
        entry = flow.load_stored(CAM, d1)["frames"][key]["A"]
        placed = engine.resolve_roi_for_frame(CAM, "part", key, width, height)
        self.assertAlmostEqual((placed.x + placed.w / 2) * width, entry["x"] + 10.0, delta=0.6)

    def test_calculate_detail_names_its_detector_and_the_crops_above_it(self) -> None:
        crop, width, height = self._crop([20, 30, 200, 150])
        det = self.node("detector")
        self.post("/edges", {"source": crop, "target": det})
        calc = self.node("calc")
        self.post("/edges", {"source": det, "target": calc})
        detail = self.node_detail(calc)
        self.assertEqual(detail["input"], det)
        self.assertEqual(len(detail["crops"]), 1)
