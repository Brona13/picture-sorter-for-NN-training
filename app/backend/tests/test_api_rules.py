from __future__ import annotations

import cv2
import numpy as np

import classify_view as cv
import datamodel
import edge_angle
import ingest
from api import classify_api
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job
from tests.test_edge_angle import edge_image, settings_for

CAM, FEAT = "camA", "seal"


def line_body(angle: float, **over) -> dict:
    s = settings_for(angle)
    return {k: s[k] for k in ("p1", "p2", "half_width", "points")} | over


class EdgeAngleApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        datamodel.ensure_camera_dirs(CAM)
        pics = {
            "a_vertical_plus.png": edge_image(90, noise=3, seed=1),
            "b_vertical_plus.png": edge_image(90, noise=3, seed=2, offset=3),
            "c_tilted.png": edge_image(70, seed=3),
            "d_vertical_minus.png": edge_image(90, bright_left=False, seed=4),
            "e_flat.png": np.full((200, 200, 3), 120, np.uint8),
        }
        for name, img in pics.items():
            cv2.imwrite(str(datamodel.unsorted_dir(CAM) / name), img)
        ingest.rebuild_index(CAM)
        self.frames = list(pics)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        self.base = f"/api/cameras/{CAM}/rules/edge-angle/{FEAT}"

    def put(self, settings):
        return self.client.put(self.base, json={"settings": settings})

    def run_rule(self) -> dict:
        r = self.client.post(f"{self.base}/run")
        self.assertEqual(r.status_code, 202, r.text)
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        return job["result"]

    def test_defaults_then_save_validate_and_remove(self) -> None:
        st = self.client.get(self.base).json()
        self.assertEqual((st["settings"], st["results"], st["summary"]), (None, "none", None))
        self.assertEqual(st["ranges"]["points"], list(edge_angle.POINTS_RANGE))
        bad = self.put({**line_body(90), "p2": line_body(90)["p1"]})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(self.put({**line_body(90), "points": 99}).status_code, 422)
        ok = self.put(line_body(90, expected={"angle": 90, "tolerance": 4, "polarity": "+"}))
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["settings"]["expected"], {"angle": 90.0, "tolerance": 4.0, "polarity": "+"})
        self.assertIsNone(self.put(None).json()["settings"])

    def test_preview_measures_with_unsaved_settings(self) -> None:
        r = self.client.post(f"{self.base}/preview", json={"frame": self.frames[0], "settings": line_body(90)})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        m = out["measurement"]
        self.assertEqual((m["status"], m["polarity"]), ("ok", "+"))
        self.assertLess(abs(m["angle"] - 90), 1.5)
        self.assertIsNone(out["verdict"])
        self.assertEqual(len(out["band"]), 4)
        self.assertTrue(out["patch"].startswith("data:image/png;base64,"))
        self.assertEqual(out["crop_size"], [200, 200])
        self.assertEqual(self.client.get(self.base).json()["settings"], None)  # preview saves nothing
        exp = {"angle": 90, "tolerance": 4, "polarity": "-"}
        r2 = self.client.post(f"{self.base}/preview", json={"frame": self.frames[0], "settings": line_body(90, expected=exp)})
        self.assertEqual(r2.json()["verdict"], "fail")  # opposite direction

    def test_preview_unknown_frame_and_bad_settings(self) -> None:
        self.assertEqual(self.client.post(f"{self.base}/preview", json={"frame": "nope.png", "settings": line_body(90)}).status_code, 404)
        self.assertEqual(self.client.post(f"{self.base}/preview", json={"frame": self.frames[0], "settings": line_body(90, half_width=2)}).status_code, 422)

    def test_run_needs_saved_settings_then_counts_verdicts(self) -> None:
        self.assertEqual(self.client.post(f"{self.base}/run").status_code, 422)
        self.put(line_body(90, expected={"angle": 90, "tolerance": 4, "polarity": "+"}))
        summary = self.run_rule()
        self.assertEqual(summary, {"total": 5, "pass": 2, "fail": 2, "undetermined": 1, "measured": 0})
        st = self.client.get(self.base).json()
        self.assertEqual((st["results"], st["summary"]), ("fresh", summary))

    def test_changing_the_line_makes_results_stale_but_the_tolerance_does_not(self) -> None:
        self.put(line_body(90, expected={"angle": 90, "tolerance": 4, "polarity": "+"}))
        self.run_rule()
        self.put(line_body(90, expected={"angle": 90, "tolerance": 30, "polarity": "+"}))  # verdict-only change
        st = self.client.get(self.base).json()
        self.assertEqual(st["results"], "fresh")
        self.assertEqual(st["summary"]["pass"], 3)  # the tilted frame (70 deg) passes a 30 degree tolerance
        self.put(line_body(90, points=6, expected={"angle": 90, "tolerance": 4, "polarity": "+"}))
        st = self.client.get(self.base).json()
        self.assertEqual((st["results"], st["summary"]), ("stale", None))

    def test_classify_state_offers_edge_views_only_with_fresh_results_and_an_expectation(self) -> None:
        url = f"/api/cameras/{CAM}/classify/state"
        self.assertNotIn("Edge angle: pass", self.client.get(url, params={"feature": FEAT}).json()["views"])
        self.put(line_body(90, expected={"angle": 90, "tolerance": 4, "polarity": "+"}))
        self.assertNotIn("Edge angle: pass", self.client.get(url, params={"feature": FEAT}).json()["views"])  # not run yet
        self.run_rule()
        views = self.client.get(url, params={"feature": FEAT}).json()["views"]
        self.assertEqual(views[-4:], ["Edge angle: pass", "Edge angle: fail", "Edge angle: undetermined", "Deleted"])
        self.put(line_body(90))  # measuring only, no expectation: nothing to filter by
        self.assertNotIn("Edge angle: pass", self.client.get(url, params={"feature": FEAT}).json()["views"])

    def test_edge_state_maps_verdicts_by_frame(self) -> None:
        self.put(line_body(90, expected={"angle": 90, "tolerance": 4, "polarity": "+"}))
        self.run_rule()
        edge = classify_api._edge_state(CAM, FEAT)
        self.assertEqual(edge["verdicts"][self.frames[0]], "pass")
        self.assertEqual(edge["verdicts"][self.frames[2]], "fail")
        self.assertEqual(edge["verdicts"][self.frames[4]], "undetermined")
        card = classify_api._edge_card(edge, self.frames[3])
        self.assertEqual((card["verdict"], card["polarity"]), ("fail", "-"))
        self.assertIsNone(classify_api._edge_card(edge, "unknown.png"))

    def test_freeze_records_the_rule(self) -> None:
        self.put(line_body(90, expected={"angle": 90, "tolerance": 4, "polarity": "+"}))
        self.run_rule()
        r = self.client.post(f"/api/cameras/{CAM}/versions", json={"feature": FEAT, "name": "v", "notes": ""})
        self.assertEqual(r.status_code, 201, r.text)
        listed = self.client.get(f"/api/cameras/{CAM}/versions", params={"feature": FEAT}).json()["versions"]
        rule = listed[0]["stats"]["rules"]["edge_angle"]
        self.assertEqual(rule["results"], "fresh")
        self.assertEqual(rule["summary"]["pass"], 2)
        self.assertEqual(rule["settings"]["expected"]["polarity"], "+")


class EdgeViewFilterTests(ApiTestCase):
    def test_filter_and_sort_by_edge_verdict(self) -> None:
        class R:
            def __init__(self, frame):
                self.frame, self.per_method = frame, {}

        results = [R("a"), R("b"), R("c")]
        out = cv.filter_and_sort(
            results, view="Edge angle: fail", rank_method="cpu", order="Name", scored=False,
            methods=[], lab={}, gold={}, edge_verdicts={"a": "pass", "b": "fail", "c": "undetermined"},
        )
        self.assertEqual([r.frame for r in out], ["b"])
        self.assertEqual(cv.valid_views(["OK", "NG"])[-1], "Deleted")
        self.assertIn("Edge angle: pass", cv.valid_views(["OK", "NG"], edge_angle=True))
