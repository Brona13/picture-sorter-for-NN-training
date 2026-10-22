"""Detector -> Calculate -> Tolerance boxes on the chain (see ``flow.py``). Temp roots only."""
from __future__ import annotations

import base64

import cv2
import numpy as np

import benchmark_rotsearch as bench
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

    def test_first_detector_appears_on_the_canvas_without_a_line(self) -> None:
        node = self.node("detector")  # v1.88.0: no automatic line, not even for the first box
        canvas = self.client.get(f"/api/cameras/{CAM}/chain").json()
        self.assertIn(node, [n["id"] for n in canvas["nodes"]])
        self.assertNotIn(node, [e["target"] for e in canvas["edges"]])
        self.assertEqual(flow.load_graph(CAM)["edges"], [])

    def test_no_box_gets_an_arrow_by_itself(self) -> None:
        calc = self.node("calc")
        det, other = self.node("detector"), self.node("detector")
        crop = self.node("crop")
        self.assertEqual(flow.load_graph(CAM)["edges"], [])
        self.assertEqual(flow.parent_of(flow.load_graph(CAM), det), None)
        self.assertEqual(other, "det:2")
        self.assertEqual(calc, "calc:1")

    def test_an_ingest_arrow_can_be_removed(self) -> None:
        det = self.node("detector")
        self.post("/edges", {"source": "ingest", "target": det})
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
        graph["nodes"][crop]["steps"][0]["rect"] = [0.25, 0.5, 0.5, 0.5]
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

    # --- a Crop that follows a detector target ---------------------------------------------------
    def _following_crop(self):
        """Detector A (left hole with its notch) -> Crop around it, drawn on the first picture. Returns (A, crop, x0, y0)."""
        import labels  # noqa: PLC0415

        a = self.detector({"A": LEFT_BOX})
        self.run_all()
        key = labels.hash_map(CAM)[self.names[0]]
        found = flow.load_stored(CAM, a)["frames"][key]["A"]
        x0, y0 = int(round(found["x"])) - 45, int(round(found["y"])) - 40
        crop = self.node("crop")
        self.post("/edges", {"source": a, "target": crop, "point": "A"})
        self.put(f"/nodes/{crop}", {"follow": {"frame": self.names[0], "rect": [x0, y0, 90, 80]}})
        return a, crop, x0, y0

    def test_a_crop_follows_the_target_and_passes_on_a_picture_of_the_same_size(self) -> None:
        a, crop, x0, y0 = self._following_crop()
        detail = self.node_detail(crop)
        self.assertEqual((detail["follow"]["detector"], detail["follow"]["target"], detail["follow"]["size"]), (a, "A", [90, 80]))
        self.assertEqual(detail["follow"]["missing"], [])
        for name in self.names:
            r = self.client.get(f"{self.base}/nodes/{crop}/picture", params={"frame": name, "stage": "output"})
            self.assertEqual(r.status_code, 200, (name, r.text))
            self.assertEqual(cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR).shape[:2], (80, 90), name)
        whole = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.names[0]))
        out = self.client.get(f"{self.base}/nodes/{crop}/picture", params={"frame": self.names[0], "stage": "output"})
        self.assertTrue(np.array_equal(cv2.imdecode(np.frombuffer(out.content, np.uint8), cv2.IMREAD_COLOR), whole[y0:y0 + 80, x0:x0 + 90]))

    def test_a_detector_behind_a_following_crop_is_placed_back_on_the_whole_picture(self) -> None:
        import labels  # noqa: PLC0415

        a, crop, x0, y0 = self._following_crop()
        plain = self.detector({"P": LEFT_BOX})  # looks for what A looks for, on the whole picture
        b = self.node("detector")
        self.post("/edges", {"source": crop, "target": b})
        self.post(f"/nodes/{b}/targets", {"name": "P"})
        self.post(f"/nodes/{b}/examples", {"target": "P", "frame": self.names[0], "box": [LEFT_BOX[0] - x0, LEFT_BOX[1] - y0, LEFT_BOX[2], LEFT_BOX[3]]})
        self.run_all()
        graph = flow.load_graph(CAM)
        rects = flow.input_rects(graph, b)
        self.assertTrue(flow.has_follow(rects))
        finder = flow.Finder(CAM)
        sizes = flow._frame_sizes(CAM)
        stored_b, stored_plain = flow.load_stored(CAM, b)["frames"], flow.load_stored(CAM, plain)["frames"]
        for name in self.names:
            key = labels.hash_map(CAM)[name]
            ox, oy = flow.rect_offset(rects, *sizes[key], found=finder.for_frame(key))
            self.assertAlmostEqual(stored_b[key]["P"]["x"] + ox, stored_plain[key]["P"]["x"], delta=2.0, msg=name)
            self.assertAlmostEqual(stored_b[key]["P"]["y"] + oy, stored_plain[key]["P"]["y"], delta=2.0, msg=name)
        # Calculate measures on the whole picture: dx between the two detectors' points equals the plain difference
        calc = self.node("calc")
        self.post("/edges", {"source": plain, "target": calc, "point": "P"})
        self.post("/edges", {"source": b, "target": calc, "point": "P"})
        self.put(f"/nodes/{calc}", {"op": "dx"})
        values = flow.calc_values(CAM, calc)
        key0 = labels.hash_map(CAM)[self.names[0]]
        self.assertAlmostEqual(values[key0], 0.0, delta=2.0)

    def test_a_picture_without_a_box_of_the_target_has_no_crop_and_is_listed(self) -> None:
        import labels  # noqa: PLC0415

        a, crop, x0, y0 = self._following_crop()
        b = self.node("detector")
        self.post("/edges", {"source": crop, "target": b})
        self.post(f"/nodes/{b}/targets", {"name": "P"})
        self.post(f"/nodes/{b}/examples", {"target": "P", "frame": self.names[0], "box": [LEFT_HOLE[0] - x0, LEFT_HOLE[1] - y0, LEFT_HOLE[2], LEFT_HOLE[3]]})
        key = labels.hash_map(CAM)[self.names[2]]
        stored = flow.load_stored(CAM, a)
        del stored["frames"][key]["A"]
        flow._store(CAM, a, stored["sig"], stored["frames"])
        self.assertEqual(self.node_detail(crop)["follow"]["missing"], [self.names[2]])
        self.assertEqual(self.node_detail(b)["no_crop"], [self.names[2]])
        r = self.client.get(f"{self.base}/nodes/{crop}/picture", params={"frame": self.names[2], "stage": "output"})
        self.assertEqual(r.status_code, 422)
        flow.run_detector(CAM, b)
        self.assertEqual(flow.load_stored(CAM, b)["frames"][key], {})
        self.assertEqual(self.node_detail(b)["summary"]["review"], 1)

    def test_a_target_offers_its_position_by_default_and_the_ticks_are_kept_per_target(self) -> None:
        a = self.detector({"A": LEFT_BOX})
        self.post(f"/nodes/{a}/targets", {"name": "B"})
        outputs = lambda: {t["name"]: t["outputs"] for t in self.node_detail(a)["targets"]}  # noqa: E731
        self.assertEqual(outputs(), {"A": ["position"], "B": ["position"]})
        r = self.client.put(f"{self.base}/nodes/{a}/targets/A/outputs", json={"outputs": ["size", "angle", "position"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(outputs(), {"A": ["position", "angle", "size"], "B": ["position"]})  # fixed order, B untouched
        self.assertEqual(self.client.put(f"{self.base}/nodes/{a}/targets/A/outputs", json={"outputs": ["colour"]}).status_code, 422)
        self.assertEqual(self.client.put(f"{self.base}/nodes/{a}/targets/Z/outputs", json={"outputs": []}).status_code, 422)
        self.assertEqual(self.client.put(f"{self.base}/nodes/{a}/targets/B/outputs", json={"outputs": []}).status_code, 200)  # position can be unticked
        # a target stored before the ticks existed offers its position
        graph = flow.load_graph(CAM)
        for t in graph["nodes"][a]["targets"]:
            t.pop("outputs", None)
        flow.save_graph(CAM, graph)
        self.assertEqual(outputs(), {"A": ["position"], "B": ["position"]})

    def test_the_position_cannot_be_unticked_while_a_line_reads_it_and_the_crop_lists_what_it_can_use(self) -> None:
        a, crop, _, _ = self._following_crop()
        r = self.client.put(f"{self.base}/nodes/{a}/targets/A/outputs", json={"outputs": ["angle"]})
        self.assertEqual(r.status_code, 422)
        self.assertIn(crop, r.text)
        self.assertEqual(self.node_detail(a)["targets"][0]["outputs"], ["position"])
        self.assertEqual(self.client.put(f"{self.base}/nodes/{a}/targets/A/outputs", json={"outputs": ["position", "angle"]}).status_code, 200)
        self.assertEqual(self.node_detail(crop)["follow"]["offered"], ["position", "angle"])  # read fresh on every request
        modes = self.node_detail(crop)["follow"]["modes"]
        self.assertEqual([(m["id"], m["enabled"]) for m in modes], [("keep", True), ("straighten", True)])
        self.assertEqual(self.client.put(f"{self.base}/nodes/{crop}", json={"follow_mode": "keep"}).status_code, 200)
        self.assertEqual(self.client.put(f"{self.base}/nodes/{crop}", json={"follow_mode": "spin"}).status_code, 422)

    def _straightening_crop(self):
        """Detector A with Angle ticked -> a Crop that straightens, its rectangle drawn on the first picture."""
        import labels  # noqa: PLC0415

        a = self.detector({"A": LEFT_BOX})
        self.assertEqual(self.client.put(f"{self.base}/nodes/{a}/targets/A/outputs", json={"outputs": ["position", "angle"]}).status_code, 200)
        self.run_all()
        key = labels.hash_map(CAM)[self.names[0]]
        found = flow.load_stored(CAM, a)["frames"][key]["A"]
        crop = self.node("crop")
        self.post("/edges", {"source": a, "target": crop, "point": "A"})
        self.put(f"/nodes/{crop}", {"follow_mode": "straighten"})
        x0, y0 = int(round(found["x"])) - 45, int(round(found["y"])) - 40
        self.put(f"/nodes/{crop}", {"follow": {"frame": self.names[0], "rect": [x0, y0, 90, 80]}})
        return a, crop

    def test_a_straightening_crop_shows_the_part_the_same_way_on_turned_pictures(self) -> None:
        a, crop = self._straightening_crop()
        outs = []
        for name in self.names:
            r = self.client.get(f"{self.base}/nodes/{crop}/picture", params={"frame": name, "stage": "output"})
            self.assertEqual(r.status_code, 200, (name, r.text))
            img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_GRAYSCALE)
            self.assertEqual(img.shape, (80, 90), name)
            outs.append(img.astype(np.float32))
        for name, img in zip(self.names[1:], outs[1:]):  # 2, 30 and 358 degrees look like the upright one
            self.assertLess(float(np.mean(np.abs(img - outs[0]))), 6.0, name)
        # keeping the orientation would not: the same cut of the 30 degree picture is turned
        self.put(f"/nodes/{crop}", {"follow_mode": "keep"})
        self.assertIsNone(self.node_detail(crop)["follow"]["size"])  # another mode: draw the rectangle again

    def test_the_straightened_whole_picture_keeps_its_size_and_the_target_in_place(self) -> None:
        a, crop = self._straightening_crop()
        for name, angle in zip(self.names, ANGLES):
            r = self.client.get(f"{self.base}/nodes/{crop}/picture", params={"frame": name, "stage": "input", "straighten": True})
            self.assertEqual(r.status_code, 200, r.text)
            turned_back = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_GRAYSCALE)
            plain = cv2.imread(str(datamodel.unsorted_dir(CAM) / name), cv2.IMREAD_GRAYSCALE)
            self.assertEqual(turned_back.shape, plain.shape)

    def test_points_found_behind_a_straightening_crop_are_taken_back_to_the_whole_picture(self) -> None:
        import labels  # noqa: PLC0415

        a, crop = self._straightening_crop()
        behind = self.detector({"P": LEFT_HOLE}, parent=crop, rotate=False)  # a detector behind the Crop
        rects = flow.input_rects(flow.load_graph(CAM), behind)
        hmap = labels.hash_map(CAM)
        for name, angle in zip(self.names, ANGLES):
            key = hmap[name]
            entry = flow.load_stored(CAM, a)["frames"][key]["A"]
            width, height = cv2.imread(str(datamodel.unsorted_dir(CAM) / name)).shape[1::-1]
            where = flow.rect_map(rects, width, height, flow.Finder(CAM).for_frame(key))
            # the target itself lies at the same place in every straightened crop: the rectangle's centre minus the offset
            spec = flow.load_graph(CAM)["nodes"][crop]["follow"]
            crop_xy = ((spec["size"][0] - 1) / 2.0 - spec["offset"][0], (spec["size"][1] - 1) / 2.0 - spec["offset"][1])
            x, y = where.point(*crop_xy)
            self.assertAlmostEqual(x, entry["x"], delta=0.01, msg=name)
            self.assertAlmostEqual(y, entry["y"], delta=0.01, msg=name)
            self.assertAlmostEqual(where.turn, entry.get("angle", 0.0), delta=0.01, msg=name)

    def test_the_angle_cannot_be_unticked_while_a_crop_straightens_with_it(self) -> None:
        a, crop = self._straightening_crop()
        r = self.client.put(f"{self.base}/nodes/{a}/targets/A/outputs", json={"outputs": ["position"]})
        self.assertEqual(r.status_code, 422)
        self.assertIn(crop, r.text)
        self.put(f"/nodes/{crop}", {"follow_mode": "keep"})
        self.assertEqual(self.client.put(f"{self.base}/nodes/{a}/targets/A/outputs", json={"outputs": ["position"]}).status_code, 200)
        r = self.client.put(f"{self.base}/nodes/{crop}", json={"follow_mode": "straighten"})
        self.assertEqual(r.status_code, 422)  # the target no longer offers the angle

    def test_a_following_crop_is_drawn_for_one_target_and_needs_a_run_of_its_detector(self) -> None:
        a = self.detector({"A": LEFT_BOX})
        crop = self.node("crop")
        r = self.client.post(f"{self.base}/edges", json={"source": a, "target": crop})
        self.assertEqual(r.status_code, 422)  # the arrow must carry a target
        r = self.client.put(f"{self.base}/nodes/{crop}", json={"follow": {"frame": self.names[0], "rect": [0, 0, 50, 50]}})
        self.assertEqual(r.status_code, 422)  # nothing is connected yet
        self.post("/edges", {"source": a, "target": crop, "point": "A"})
        r = self.client.put(f"{self.base}/nodes/{crop}", json={"follow": {"frame": self.names[0], "rect": [0, 0, 50, 50]}})
        self.assertEqual(r.status_code, 422)  # the detector has found nothing yet
        self.run_all()
        b = self.node("detector")
        self.post("/edges", {"source": crop, "target": b})
        self.post(f"/nodes/{b}/targets", {"name": "P"})
        self.assertEqual(self.node_detail(crop)["follow"]["size"], None)

    def test_the_drawn_rectangle_is_forgotten_when_the_crop_follows_another_target(self) -> None:
        a, crop, x0, y0 = self._following_crop()
        self.post(f"/nodes/{a}/targets", {"name": "B"})
        self.post(f"/nodes/{a}/examples", {"target": "B", "frame": self.names[0], "box": RIGHT_BOX})
        self.post("/edges", {"source": a, "target": crop, "point": "B"})
        self.assertEqual(self.node_detail(crop)["follow"]["size"], None)
        self.assertEqual(self.node_detail(crop)["follow"]["target"], "B")

    def test_a_detector_behind_a_following_crop_goes_stale_when_its_source_detector_changes(self) -> None:
        a, crop, x0, y0 = self._following_crop()
        b = self.node("detector")
        self.post("/edges", {"source": crop, "target": b})
        self.post(f"/nodes/{b}/targets", {"name": "P"})
        self.post(f"/nodes/{b}/examples", {"target": "P", "frame": self.names[0], "box": [LEFT_HOLE[0] - x0, LEFT_HOLE[1] - y0, LEFT_HOLE[2], LEFT_HOLE[3]]})
        self.run_all()
        self.assertEqual(self.node_detail(b)["status"], "fresh")
        self.put(f"/nodes/{a}", {"rotate": False})
        self.assertEqual(self.node_detail(a)["status"], "stale")
        self.assertEqual(self.node_detail(b)["status"], "stale")
        with self.assertRaises(flow.FlowError):
            flow.run_detector(CAM, b)  # run the detector the Crop follows first

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

    def test_turned_rectangle_is_cut_upright_and_keeps_its_turn(self) -> None:
        d1 = self.detector({"A": LEFT_BOX})
        plain = self.client.get(f"{self.base}/nodes/{d1}").json()["targets"][0]["examples"][0]
        self.assertEqual(plain["angle"], 0.0)
        # where the left hole lies on the picture turned by 30 degrees (the picture is turned about its centre)
        height, width = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.names[2])).shape[:2]
        m = cv2.getRotationMatrix2D(((width - 1) / 2.0, (height - 1) / 2.0), 30.0, 1.0)
        cx, cy = LEFT_BOX[0] + LEFT_BOX[2] / 2.0 - 0.5, LEFT_BOX[1] + LEFT_BOX[3] / 2.0 - 0.5
        nx, ny = m @ np.array([cx, cy, 1.0])
        box = [int(round(nx + 0.5 - LEFT_BOX[2] / 2.0)), int(round(ny + 0.5 - LEFT_BOX[3] / 2.0)), LEFT_BOX[2], LEFT_BOX[3]]
        added = self.post(f"/nodes/{d1}/examples", {"target": "A", "frame": self.names[2], "box": box, "angle": 30})
        stamped = added["targets"][0]["examples"][1]
        self.assertEqual(stamped["angle"], 30.0)
        self.assertEqual(stamped["box"], box)

        def pixels(example: dict) -> np.ndarray:
            raw = base64.b64decode(example["png"].split(",", 1)[1])
            return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE).astype(np.float32)

        a, b = pixels(plain), pixels(stamped)
        self.assertEqual(a.shape, b.shape)
        self.assertGreater(float(np.corrcoef(a.ravel(), b.ravel())[0, 1]), 0.9)
        # moving it keeps the turn unless a new one is given; a turn of 0 clears it
        moved = self.put(f"/nodes/{d1}/examples/A/1", {"box": box})  # PUT replies 200
        self.assertEqual(moved["targets"][0]["examples"][1]["angle"], 30.0)
        cleared = self.put(f"/nodes/{d1}/examples/A/1", {"box": box, "angle": 0})
        self.assertEqual(cleared["targets"][0]["examples"][1]["angle"], 0.0)
        # the centre has to lie on the picture
        off = self.client.post(f"{self.base}/nodes/{d1}/examples", json={"target": "A", "frame": self.names[2], "box": [width + 20, 10, 40, 40], "angle": 30})
        self.assertEqual(off.status_code, 422)

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
        # Nominal 355 +- 10 covers 345-360 and 0-5 (around the clock).
        node = {"nominal": 355.0, "tolerance": 10.0}
        self.assertEqual([flow.judge(v, node, True) for v in (345.0, 355.0, 359.9, 0.0, 5.0)], ["pass"] * 5)
        self.assertEqual([flow.judge(v, node, True) for v in (344.0, 6.0, 180.0)], ["fail"] * 3)

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

    def test_crop_arrows_are_typed_and_no_box_reads_ingest_by_itself(self) -> None:
        crop, other, det = self.node("crop"), self.node("crop"), self.node("detector")
        self.assertNotIn({"source": "ingest", "target": crop}, flow.load_graph(CAM)["edges"])
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


class LargeExampleTests(ApiTestCase):
    """An example over 400 px is stored shrunk and the detector shrinks the picture the same way (v1.75.0)."""

    SIZE = 500
    CENTRES = [(400.0, 350.0), (520.0, 420.0), (380.0, 300.0)]

    def setUp(self) -> None:
        super().setUp()
        self.cam = "camL"
        datamodel.ensure_camera_dirs(self.cam)
        rng = np.random.default_rng(3)
        pattern = bench.pattern(self.SIZE)
        self.names = []
        for i, (cx, cy) in enumerate(self.CENTRES):
            frame = bench.plant(bench.background(1000, rng), pattern, cx, cy, 0.0)
            name = f"big_{i}.png"
            cv2.imwrite(str(datamodel.unsorted_dir(self.cam) / name), frame)
            self.names.append(name)
        ingest.rebuild_index(self.cam)
        self.base = f"/api/cameras/{self.cam}/flow"
        self.det = self.client.post(f"{self.base}/nodes", json={"kind": "detector"}).json()["id"]
        self.client.put(f"{self.base}/nodes/{self.det}", json={"rotate": False})

    def target(self, name: str) -> None:
        self.assertEqual(self.client.post(f"{self.base}/nodes/{self.det}/targets", json={"name": name}).status_code, 201)

    def example(self, target: str, box: list[int], status: int = 201):
        r = self.client.post(f"{self.base}/nodes/{self.det}/examples", json={"target": target, "frame": self.names[0], "box": box})
        self.assertEqual(r.status_code, status, r.text)
        return r

    def detail(self) -> dict:
        return self.client.get(f"{self.base}/nodes/{self.det}").json()

    def test_a_large_example_is_stored_shrunk_and_the_box_stays_in_picture_pixels(self) -> None:
        self.target("part")
        self.example("part", [150, 100, 500, 500])  # was refused: "at most 400 pixels on a side"
        example = self.detail()["targets"][0]["examples"][0]
        self.assertEqual(example["box"], [150, 100, 500, 500])
        self.assertAlmostEqual(example["scale"], 0.8, places=4)
        png = cv2.imdecode(np.frombuffer(__import__("base64").b64decode(example["png"].split(",", 1)[1]), np.uint8), cv2.IMREAD_UNCHANGED)
        self.assertEqual(png.shape[:2], (400, 400))

    def test_the_detector_finds_a_large_example_in_original_pixels(self) -> None:
        self.target("part")
        self.example("part", [150, 100, 500, 500])
        job = self.client.post(f"{self.base}/run").json()
        self.assertEqual(wait_for_job(self.client, job["id"])["status"], "done")
        boxes = self.client.get(f"{self.base}/nodes/{self.det}/boxes").json()["boxes"]
        for name, (cx, cy) in zip(self.names, self.CENTRES):
            found = boxes[name]["part"]
            self.assertLess(abs(found["x"] - cx), 2.5, name)  # the shrink costs about 1 / scale pixel
            self.assertLess(abs(found["y"] - cy), 2.5, name)
            self.assertEqual((found["w"], found["h"]), (500, 500))  # the example's own size, not the shrunk one
        self.assertEqual(self.detail()["status"], "fresh")

    def test_a_small_example_of_the_same_detector_is_shrunk_with_it(self) -> None:
        self.target("part")
        self.target("notch")
        self.example("part", [150, 100, 500, 500])
        self.example("notch", [345, 295, 110, 110])  # inside the large pattern
        job = self.client.post(f"{self.base}/run").json()
        self.assertEqual(wait_for_job(self.client, job["id"])["status"], "done")
        boxes = self.client.get(f"{self.base}/nodes/{self.det}/boxes").json()["boxes"]
        found = boxes[self.names[1]]["notch"]
        self.assertEqual((found["w"], found["h"]), (110, 110))
        self.assertLess(abs(found["x"] - (400.0 + 120.0)), 3.0)  # the frame's pattern moved by (+120, +70)
        self.assertLess(abs(found["y"] - (350.0 + 70.0)), 3.0)

    def test_an_example_that_fits_keeps_its_old_form(self) -> None:
        self.target("part")
        self.example("part", [250, 200, 300, 300])
        self.assertEqual(self.detail()["targets"][0]["examples"][0]["scale"], 1.0)
        stored = flow.load_graph(self.cam)["nodes"][self.det]["targets"][0]["examples"][0]
        self.assertNotIn("scale", stored)  # nothing new is stored for an example that was never shrunk

    def test_resizing_a_large_example_to_fit_drops_the_scale(self) -> None:
        self.target("part")
        self.example("part", [150, 100, 500, 500])
        r = self.client.put(f"{self.base}/nodes/{self.det}/examples/part/0", json={"box": [200, 150, 380, 380]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["targets"][0]["examples"][0]["scale"], 1.0)

    def test_an_example_too_large_for_a_small_one_of_the_detector_is_refused_with_a_reason(self) -> None:
        self.target("part")
        self.target("dot")
        self.example("dot", [513, 344, 12, 12])  # on the edge of the dark disc
        self.example("part", [150, 100, 500, 500])  # 12 px * 0.8 = 9.6 px: still fine
        self.assertEqual(len(self.detail()["targets"][1]["examples"]), 1)
        big = self.client.post(
            f"{self.base}/nodes/{self.det}/examples", json={"target": "part", "frame": self.names[0], "box": [0, 0, 1000, 1000]}
        )  # 12 px * 0.4 = 4.8 px < 8
        self.assertEqual(big.status_code, 422, big.text)
        self.assertIn("too large next to a small one", big.json()["detail"])
        self.assertEqual(len(self.detail()["targets"][0]["examples"]), 1)  # nothing was added

    def test_a_cascaded_detector_with_its_own_large_example_searches_inside_the_parent_box(self) -> None:
        self.target("part")
        self.example("part", [150, 100, 500, 500])  # parent, scale 0.8
        child = self.client.post(f"{self.base}/nodes", json={"kind": "detector"}).json()["id"]
        self.client.put(f"{self.base}/nodes/{child}", json={"rotate": False})
        self.assertEqual(self.client.post(f"{self.base}/edges", json={"source": self.det, "target": child}).status_code, 201)
        r = self.client.post(f"{self.base}/nodes/{child}/targets", json={"name": "inner", "inside": "part"})
        self.assertEqual(r.status_code, 201, r.text)
        r = self.client.post(f"{self.base}/nodes/{child}/examples", json={"target": "inner", "frame": self.names[0], "box": [190, 140, 420, 420]})
        self.assertEqual(r.status_code, 201, r.text)  # 420 px: shrunk too
        self.assertLess(self.client.get(f"{self.base}/nodes/{child}").json()["targets"][0]["examples"][0]["scale"], 1.0)
        job = self.client.post(f"{self.base}/run").json()
        self.assertEqual(wait_for_job(self.client, job["id"])["status"], "done")
        boxes = self.client.get(f"{self.base}/nodes/{child}/boxes").json()["boxes"]
        for name, (cx, cy) in zip(self.names, self.CENTRES):
            found = boxes[name]["inner"]
            self.assertLess(abs(found["x"] - cx), 3.0, name)
            self.assertLess(abs(found["y"] - cy), 3.0, name)
            self.assertEqual((found["w"], found["h"]), (420, 420))
