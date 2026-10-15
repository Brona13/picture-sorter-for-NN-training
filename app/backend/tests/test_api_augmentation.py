from __future__ import annotations

import cv2

import datamodel
import detections
import ingest
import labels
import motion
import vision_settings
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job
from tests.test_motion import W, H, bgr, move, texture

CAM, FEAT = "camA", "seal"
# (name, dx, dy, rotation): f00 is the reference; the rest move around it.
MOVES = [
    ("f00_ref.png", 0, 0, 0.0),
    ("f01.png", 4, 0, 0.0),
    ("f02.png", -6, 3, 0.0),
    ("f03.png", 2, -5, 0.0),
    ("f04.png", 8, 6, 0.0),
    ("f05.png", -3, -2, 2.0),
]


class AugmentationApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        datamodel.ensure_camera_dirs(CAM)
        base = texture()
        for name, dx, dy, deg in MOVES:
            cv2.imwrite(str(datamodel.unsorted_dir(CAM) / name), bgr(move(base, dx, dy, deg)))
        ingest.rebuild_index(CAM)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        self.frames = [m[0] for m in MOVES]
        self.base = f"/api/cameras/{CAM}/augmentation/{FEAT}"

    def put(self, **settings):
        return self.client.put(self.base, json={"settings": {"reference": self.frames[0], **settings}})

    def run_job(self) -> dict:
        r = self.client.post(f"{self.base}/run")
        self.assertEqual(r.status_code, 202, r.text)
        job = wait_for_job(self.client, r.json()["id"])
        self.assertEqual(job["status"], "done", job)
        return job["result"]

    def state(self, **params) -> dict:
        return self.client.get(self.base, params=params).json()

    def test_defaults_before_anything_is_saved_or_run(self) -> None:
        st = self.state()
        self.assertEqual((st["results"], st["analysis"], st["saved"], st["has_detector"]), ("none", None, False, False))
        self.assertEqual(st["settings"]["source"], "auto")
        self.assertEqual(st["reference"], self.frames[0])
        self.assertEqual(st["classes"], ["OK", "NG"])

    def test_validation(self) -> None:
        for bad in ({"source": "magic"}, {"coverage": 10}, {"label": "MAYBE"}, {"reference": "nope.png"}, {"ranges": {"dx": [3, -3]}}):
            self.assertEqual(self.put(**bad).status_code, 422, bad)
        self.assertEqual(self.client.get(self.base, params={"coverage": 5}).status_code, 422)

    def test_measures_known_shifts_by_template_matching(self) -> None:
        self.put()
        summary = self.run_job()
        self.assertEqual((summary["measured"], summary["total"], summary["reference"]), (6, 6, self.frames[0]))
        st = self.state()
        self.assertEqual(st["results"], "fresh")
        a = st["analysis"]
        self.assertEqual(a["sources"], {"detector": 0, "template": 6, "none": 0})
        self.assertEqual(a["crop"], [W, H])
        self.assertAlmostEqual(a["dx"]["max"], 8, delta=1.0)
        self.assertAlmostEqual(a["dx"]["min"], -6, delta=1.0)
        self.assertAlmostEqual(a["dy"]["max"], 6, delta=1.0)
        self.assertAlmostEqual(a["dy"]["min"], -5, delta=1.0)
        self.assertIsNone(a["rot"])  # rotation was not asked for

    def test_rotation_is_measured_on_request_and_improves_the_shift(self) -> None:
        self.put(rotation=True)
        self.run_job()
        a = self.state()["analysis"]
        self.assertEqual(a["rot"]["n"], 6)
        self.assertAlmostEqual(a["rot"]["max"], 2.0, delta=0.4)
        self.assertAlmostEqual(a["rot"]["min"], 0.0, delta=0.4)

    def test_label_filter_and_coverage_preview_do_not_save(self) -> None:
        self.put()
        self.run_job()
        for f in (self.frames[0], self.frames[1], self.frames[4]):
            labels.set_label(CAM, FEAT, f, "OK")
        only_ok = self.state(label="OK", coverage=100)["analysis"]
        self.assertEqual((only_ok["frames"], only_ok["dx"]["n"]), (3, 3))
        self.assertAlmostEqual(only_ok["dx"]["max"], 8, delta=1.0)
        self.assertEqual(self.state(label="", coverage=100)["analysis"]["frames"], 6)
        narrow = self.state(coverage=60)["analysis"]
        wide = self.state(coverage=100)["analysis"]
        self.assertGreater(narrow["dx"]["suggested"][0], wide["dx"]["suggested"][0])
        self.assertEqual(self.state()["settings"]["coverage"], 95.0)  # previews saved nothing
        self.assertIsNone(self.state()["settings"]["label"])

    def test_changing_the_ranges_keeps_results_but_changing_the_method_makes_them_stale(self) -> None:
        self.put()
        self.run_job()
        self.put(ranges={"dx": [-8, 9], "dy": [-6, 7], "rot": None})
        st = self.state()
        self.assertEqual((st["results"], st["settings"]["ranges"]["dx"]), ("fresh", [-8.0, 9.0]))
        self.put(rotation=True)
        st = self.state()
        self.assertEqual((st["results"], st["analysis"]), ("stale", None))

    def test_a_trusted_detection_wins_and_other_frames_fall_back_to_template(self) -> None:
        vision_settings.put(CAM, FEAT, {"detector": {"exemplars": [{"frame": self.frames[0], "box": {"x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2}}], "topk": 1, "threshold": 0.3}})
        hmap = labels.hash_map(CAM)
        # Human boxes (always trusted) for the reference and one moved frame: centre moves 0.05 of the width right.
        detections.set_box(CAM, FEAT, hmap[self.frames[0]], {"x": 0.40, "y": 0.40, "w": 0.2, "h": 0.2})
        detections.set_box(CAM, FEAT, hmap[self.frames[2]], {"x": 0.45, "y": 0.40, "w": 0.2, "h": 0.2})
        st = self.client.get(self.base).json()
        self.assertTrue(st["has_detector"])
        self.put()
        self.run_job()
        a = self.state()["analysis"]
        self.assertEqual(a["sources"]["detector"], 2)  # the reference itself and the boxed frame
        self.assertEqual(a["sources"]["template"], 4)
        results = motion.load_results(CAM, FEAT, motion.current_signature(CAM, FEAT, motion.get(CAM, FEAT)))["frames"]
        self.assertAlmostEqual(results[hmap[self.frames[2]]][0], 0.05 * W, places=1)  # taken from the box, not the picture
        self.assertEqual(results[hmap[self.frames[2]]][3], 1)

    def test_source_detector_leaves_unboxed_frames_unmeasured(self) -> None:
        vision_settings.put(CAM, FEAT, {"detector": {"exemplars": [{"frame": self.frames[0], "box": {"x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2}}], "topk": 1, "threshold": 0.3}})
        detections.set_box(CAM, FEAT, labels.hash_map(CAM)[self.frames[0]], {"x": 0.40, "y": 0.40, "w": 0.2, "h": 0.2})
        self.put(source="detector")
        summary = self.run_job()
        self.assertEqual(summary["measured"], 1)
        self.assertEqual(self.state()["analysis"]["sources"], {"detector": 1, "template": 0, "none": 5})

    def test_run_needs_frames_and_freeze_records_the_ranges(self) -> None:
        self.put(ranges={"dx": [-8, 9], "dy": [-6, 7], "rot": [-3, 3]}, rotation=True, coverage=90)
        self.run_job()
        r = self.client.post(f"/api/cameras/{CAM}/versions", json={"feature": FEAT, "name": "v", "notes": ""})
        self.assertEqual(r.status_code, 201, r.text)
        aug = self.client.get(f"/api/cameras/{CAM}/versions", params={"feature": FEAT}).json()["versions"][0]["stats"]["augmentation"]
        self.assertEqual(aug["ranges"], {"dx": [-8.0, 9.0], "dy": [-6.0, 7.0], "rot": [-3.0, 3.0]})
        self.assertEqual((aug["results"], aug["crop"], aug["reference"], aug["coverage"]), ("fresh", [W, H], self.frames[0], 90.0))
        self.assertIn("pixels of the ROI crop", aug["unit"])

    def test_no_ranges_means_nothing_is_frozen(self) -> None:
        self.put()  # settings but no ranges chosen yet
        self.run_job()
        r = self.client.post(f"/api/cameras/{CAM}/versions", json={"feature": FEAT, "name": "v", "notes": ""})
        self.assertEqual(r.status_code, 201)
        stats = self.client.get(f"/api/cameras/{CAM}/versions", params={"feature": FEAT}).json()["versions"][0]["stats"]
        self.assertNotIn("augmentation", stats)
