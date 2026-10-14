from __future__ import annotations

import sqlite3
from unittest import mock

import cv2
import numpy as np

import classify
import config
import datamodel
import db
import detections
import detector
import engine
import labels
import vision_settings
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job, write_frames

RECT = {"shape": "rect", "x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}
EXEMPLAR = {"frame": "frame_000.png", "box": {"x": 0.2, "y": 0.2, "w": 0.2, "h": 0.2}}  # centre (0.3, 0.3)


def box_at(cx: float, cy: float, size: float = 0.2) -> dict:
    return {"x": cx - size / 2, "y": cy - size / 2, "w": size, "h": size}


class StubBackend:
    """Returns a scripted result per call; records how often it ran."""

    def __init__(self, script: list[list[tuple[dict, float]]]) -> None:
        self.script = script
        self.calls = 0

    def __call__(self, target, queries, topk):
        out = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        return out[:topk]


class DetectorBase(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames("camA", 3)
        datamodel.save_rois("camA", [ROI(name="seal", x=0.0, y=0.0, w=0.5, h=0.5)])
        self.url = "/api/cameras/camA/vision/seal"
        self.addCleanup(detector.set_backend, None)

    def save(self, **overrides) -> None:
        body = {
            "mask": {"enabled": True, "shape": RECT},
            "detector": {"exemplars": [EXEMPLAR], "topk": 2, "threshold": 0.3},
        }
        body.update(overrides)
        r = self.client.put(self.url, json=body)
        self.assertEqual(r.status_code, 200, r.text)

    def hash_of(self, frame: str) -> str:
        return labels.frame_hash("camA", frame)


class SchemaMigrationTests(ApiTestCase):
    def test_v4_database_gains_detections_table(self) -> None:
        db.db_path().parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(db.db_path())
        con.executescript("CREATE TABLE settings (camera TEXT, key TEXT, value TEXT); PRAGMA user_version = 4;")
        con.close()
        con = db.connect()
        try:
            tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("detections", tables)
            self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], db.SCHEMA_VERSION)
        finally:
            con.close()


class MergeTests(ApiTestCase):
    def test_nms_keeps_best_of_overlapping_and_limits_topk(self) -> None:
        a, b, c = box_at(0.3, 0.3), box_at(0.31, 0.3), box_at(0.8, 0.8)
        merged = detector.merge([(a, 0.5), (b, 0.9), (c, 0.4)], topk=5)
        self.assertEqual([round(s, 1) for _, s in merged], [0.9, 0.4])
        self.assertEqual(len(detector.merge([(a, 0.5), (c, 0.4)], topk=1)), 1)


class SettingsTests(DetectorBase):
    def test_detector_roundtrip_and_validation(self) -> None:
        self.save()
        got = self.client.get(self.url).json()["detector"]
        self.assertEqual(got["topk"], 2)
        self.assertEqual(got["exemplars"][0]["frame"], "frame_000.png")
        for bad in (
            {"exemplars": [EXEMPLAR] * 4},
            {"exemplars": [{"frame": "f", "box": {"x": 0, "y": 0, "w": 0, "h": 1}}]},
            {"exemplars": [], "topk": 9},
            {"exemplars": [], "threshold": 2},
        ):
            r = self.client.put(self.url, json={"detector": bad})
            self.assertEqual(r.status_code, 422, bad)

    def test_signature_includes_exemplars_only_when_anchored(self) -> None:
        self.save(mask={"enabled": False, "shape": RECT})
        self.assertEqual(vision_settings.signature("camA", "seal"), "")
        self.save()
        anchored = vision_settings.signature("camA", "seal")
        self.assertNotEqual(anchored, "")
        other = {"frame": "frame_001.png", "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}}
        self.save(detector={"exemplars": [other], "topk": 2, "threshold": 0.3})
        self.assertNotEqual(vision_settings.signature("camA", "seal"), anchored)


class RunTests(DetectorBase):
    def test_run_stores_detections_and_offsets_follow_trusted_ones(self) -> None:
        self.save()
        stub = StubBackend([[(box_at(0.4, 0.4), 0.9)], [(box_at(0.6, 0.6), 0.1)], [(box_at(0.3, 0.5), 0.8)]])
        detector.set_backend(stub)
        result = detector.run("camA", "seal")
        self.assertEqual(result["detected"], 3)
        self.assertEqual(result["needs_review"], 1)
        settings = vision_settings.get("camA", "seal")
        offsets = detections.offsets("camA", "seal", settings)
        self.assertEqual(offsets[self.hash_of(self.frames[0])], (0.1, 0.1))
        self.assertNotIn(self.hash_of(self.frames[1]), offsets)  # below threshold: not trusted yet
        self.assertEqual(offsets[self.hash_of(self.frames[2])], (0.0, 0.2))

    def test_offsets_empty_without_enabled_mask(self) -> None:
        self.save(mask={"enabled": False, "shape": RECT})
        detector.set_backend(StubBackend([[(box_at(0.4, 0.4), 0.9)]]))
        detector.run("camA", "seal")
        self.assertEqual(detections.offsets("camA", "seal", vision_settings.get("camA", "seal")), {})

    def test_human_boxes_survive_redetection(self) -> None:
        self.save()
        detector.set_backend(StubBackend([[(box_at(0.4, 0.4), 0.9)]]))
        detector.run("camA", "seal")
        r = self.client.put(f"{self.url}/detections/{self.frames[1]}", json={"box": box_at(0.7, 0.7)})
        self.assertEqual(r.status_code, 200)
        again = detector.run("camA", "seal")
        self.assertEqual(again["skipped_human"], 1)
        rows = detections.load("camA", "seal")[self.hash_of(self.frames[1])]
        self.assertEqual((rows[0]["status"], round(rows[0]["x"], 2)), ("manual", 0.6))

    def test_run_needs_exemplars(self) -> None:
        self.save(detector=None)
        with self.assertRaises(detector.DetectorError):
            detector.run("camA", "seal")

    def test_changed_exemplars_make_auto_detections_stale(self) -> None:
        self.save()
        detector.set_backend(StubBackend([[(box_at(0.4, 0.4), 0.9)]]))
        detector.run("camA", "seal")
        other = {"frame": "frame_001.png", "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}}
        self.save(detector={"exemplars": [other], "topk": 2, "threshold": 0.3})
        self.assertEqual(detections.offsets("camA", "seal", vision_settings.get("camA", "seal")), {})


class ApiTests(DetectorBase):
    def test_detect_job_and_review_listing(self) -> None:
        self.save()
        detector.set_backend(StubBackend([[(box_at(0.4, 0.4), 0.9)], [(box_at(0.5, 0.5), 0.1)]]))
        job = self.client.post(f"{self.url}/detect").json()
        done = wait_for_job(self.client, job["id"])
        self.assertEqual(done["status"], "done", done)
        self.assertEqual(done["result"]["detected"], 3)
        listing = self.client.get(f"{self.url}/detections").json()
        states = {f["frame"]: f["state"] for f in listing["frames"]}
        self.assertEqual(states[self.frames[0]], "trusted")
        self.assertEqual(states[self.frames[1]], "review")
        queue = self.client.get(f"{self.url}/detections", params={"review_only": True}).json()
        self.assertEqual([f["frame"] for f in queue["frames"]], [self.frames[1], self.frames[2]])  # stub repeats its last result

    def test_accepting_and_clearing(self) -> None:
        self.save()
        detector.set_backend(StubBackend([[(box_at(0.5, 0.5), 0.1)]]))
        detector.run("camA", "seal")
        box = {k: v for k, v in self.client.get(f"{self.url}/detections").json()["frames"][0]["boxes"][0].items() if k != "conf"}
        r = self.client.put(f"{self.url}/detections/{self.frames[0]}", json={"box": box, "status": "reviewed"})
        self.assertEqual(r.status_code, 200)
        first = self.client.get(f"{self.url}/detections").json()["frames"][0]
        self.assertEqual(first["state"], "human")
        self.assertEqual(self.client.delete(f"{self.url}/detections/{self.frames[0]}").status_code, 200)
        self.assertEqual(self.client.get(f"{self.url}/detections").json()["frames"][0]["state"], "none")
        bad = self.client.put(f"{self.url}/detections/{self.frames[0]}", json={"box": box, "status": "auto"})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(
            self.client.put(f"{self.url}/detections/nope.png", json={"box": box}).status_code, 404
        )

    def test_detect_requires_exemplars_and_dependencies(self) -> None:
        self.assertEqual(self.client.post(f"{self.url}/detect").status_code, 422)
        self.save()
        with mock.patch.object(detector, "available", return_value=False):
            self.assertEqual(self.client.post(f"{self.url}/detect").status_code, 503)
            self.assertFalse(self.client.get("/api/vision/detector").json()["available"])

    def test_preview_shifts_mask_onto_detection(self) -> None:
        self.save()
        # frame_000's object sits 0.4 right/down of the exemplar: the (0,0)-(.5,.5) mask moves with it.
        self.client.put(f"{self.url}/detections/{self.frames[0]}", json={"box": box_at(0.7, 0.7)})
        payload = {"frame": self.frames[0], "mask": {"enabled": True, "shape": RECT},
                   "detector": {"exemplars": [EXEMPLAR], "topk": 2, "threshold": 0.3}}

        def top_left(body):
            r = self.client.post(f"{self.url}/preview", json=body)
            img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
            return img[0, 0]

        shifted = top_left(payload)
        unshifted = top_left({**payload, "detector": None})
        self.assertTrue((shifted <= 70).all())  # dark-grey blank: the mask moved away from the corner
        self.assertFalse(np.array_equal(shifted, unshifted))


class CacheKeyTests(DetectorBase):
    def test_vectors_of_shifted_frames_are_cached_under_their_offset(self) -> None:
        self.save()
        self.client.put(f"{self.url}/detections/{self.frames[0]}", json={"box": box_at(0.7, 0.7)})
        roi = engine.resolve_roi("camA", "seal")
        hmap = labels.hash_map("camA")
        con = db.connect()
        try:
            key = classify._roi_cache_key(roi, "camA", "seal", con)
            classify.fetch_vectors(con, "camA", "seal", key, roi, self.frames, hmap, [])
            hashes = {r["hash"] for r in con.execute("SELECT hash FROM score_cache")}
        finally:
            con.close()
        shifted = [h for h in hashes if "@" in h]
        self.assertEqual(len(shifted), 1)
        self.assertTrue(shifted[0].startswith(self.hash_of(self.frames[0]) + "@+0.4"))
        self.assertIn(self.hash_of(self.frames[1]), hashes)  # undetected frames keep the plain hash
