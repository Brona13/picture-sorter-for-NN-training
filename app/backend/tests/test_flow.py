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
        tol = self.node("tolerance")
        self.post("/edges", {"source": calc, "target": tol})
        return d1, d2, calc, tol

    def test_new_detector_reads_ingest_and_appears_on_the_canvas(self) -> None:
        node = self.node("detector")
        canvas = self.client.get(f"/api/cameras/{CAM}/chain").json()
        self.assertIn(node, [n["id"] for n in canvas["nodes"]])
        self.assertIn(("ingest", node), {(e["source"], e["target"]) for e in canvas["edges"]})

    def test_typed_arrows_are_checked(self) -> None:
        d, c, t = self.node("detector"), self.node("calc"), self.node("tolerance")
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
        self.assertIn(("ingest", d2), {(e["source"], e["target"]) for e in graph["edges"]})

    def test_compute_conventions(self) -> None:
        self.assertAlmostEqual(flow.compute("angle", (0, 0), (10, 0)), 0.0)
        self.assertAlmostEqual(flow.compute("angle", (0, 0), (0, -10)), 90.0)   # up on screen = counter-clockwise
        self.assertAlmostEqual(flow.compute("angle", (0, 0), (0, -10), clockwise=True), 270.0)
        self.assertAlmostEqual(flow.compute("distance", (0, 0), (3, 4)), 5.0)
        self.assertAlmostEqual(flow.deviation(359.0, 1.0, True), -2.0)

    def test_bad_settings_are_refused(self) -> None:
        tol = self.node("tolerance")
        r = self.client.put(f"{self.base}/nodes/{tol}", json={"tolerance": 0})
        self.assertEqual(r.status_code, 422)
