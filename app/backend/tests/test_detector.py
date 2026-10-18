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
import ingest
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
            "detector": {"exemplars": [EXEMPLAR], "topk": 2, "threshold": 0.3, "method": "model"},  # the model path; template matching has its own tests
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


class InputSizeTests(DetectorBase):
    def stored(self) -> dict:
        return vision_settings.get("camA", "seal")["detector"]

    def test_the_size_defaults_to_the_models_own_and_accepts_the_smaller_one(self) -> None:
        self.save()
        self.assertEqual(self.stored()["size"], 768)
        self.save(detector={"exemplars": [EXEMPLAR], "topk": 2, "threshold": 0.3, "method": "model", "size": 512})
        self.assertEqual(self.stored()["size"], 512)

    def test_other_sizes_are_refused(self) -> None:
        for bad in (640, 0, True):
            r = self.client.put(self.url, json={"detector": {"exemplars": [EXEMPLAR], "size": bad}})
            self.assertEqual(r.status_code, 422, f"{bad!r}: {r.text}")

    def test_the_info_lists_the_sizes(self) -> None:
        self.assertEqual(self.client.get("/api/vision/detector").json()["input_sizes"], [768, 512])

    def test_a_smaller_size_makes_stored_detections_stale_but_the_default_keeps_them_valid(self) -> None:
        self.save()
        default = vision_settings.detection_signature(vision_settings.get("camA", "seal"))
        legacy = vision_settings.detection_signature({**vision_settings.get("camA", "seal"), "detector": {"exemplars": [EXEMPLAR], "method": "model"}})
        self.assertEqual(default, legacy)  # a detector without a size, as stored before, hashes as the default
        self.save(detector={"exemplars": [EXEMPLAR], "topk": 2, "threshold": 0.3, "method": "model", "size": 512})
        self.assertNotEqual(vision_settings.detection_signature(vision_settings.get("camA", "seal")), default)

    def test_topk_and_threshold_do_not_change_the_detection_signature(self) -> None:
        self.save()
        before = vision_settings.detection_signature(vision_settings.get("camA", "seal"))
        self.save(detector={"exemplars": [EXEMPLAR], "topk": 5, "threshold": 0.9, "method": "model"})
        self.assertEqual(vision_settings.detection_signature(vision_settings.get("camA", "seal")), before)


class MethodTests(DetectorBase):
    """Template matching (default) and the model are two methods of one setting."""

    def test_the_method_defaults_to_template_matching_and_accepts_the_model(self) -> None:
        self.client.put(self.url, json={"detector": {"exemplars": [EXEMPLAR]}})
        self.assertEqual(vision_settings.get("camA", "seal")["detector"]["method"], "template")
        self.save()
        self.assertEqual(vision_settings.get("camA", "seal")["detector"]["method"], "model")

    def test_other_methods_are_refused_and_the_info_lists_both(self) -> None:
        r = self.client.put(self.url, json={"detector": {"exemplars": [EXEMPLAR], "method": "magic"}})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.client.get("/api/vision/detector").json()["methods"], ["template", "model"])

    def test_the_method_is_part_of_the_detection_signature_but_the_models_old_signature_is_unchanged(self) -> None:
        def sig(det):
            return vision_settings.detection_signature({"filter": None, "mask": None, "detector": det})

        model = sig({"exemplars": [EXEMPLAR], "method": "model"})
        self.assertEqual(model, sig({"exemplars": [EXEMPLAR], "method": "model", "size": 768}))
        self.assertNotEqual(model, sig({"exemplars": [EXEMPLAR], "method": "template"}))
        self.assertEqual(sig({"exemplars": [EXEMPLAR], "method": "template"}), sig({"exemplars": [EXEMPLAR], "method": "template", "size": 512}))  # size is the model's

    def test_template_matching_needs_neither_torch_nor_the_model(self) -> None:
        self.client.put(self.url, json={"detector": {"exemplars": [EXEMPLAR]}})
        with (
            mock.patch.object(detector, "available", return_value=False),
            mock.patch.object(detector, "model_cached", return_value=False),
        ):
            r = self.client.post(f"{self.url}/detect")
        self.assertEqual(r.status_code, 200, r.text)
        wait_for_job(self.client, r.json()["id"])

    def test_the_model_method_still_needs_them(self) -> None:
        self.save()
        with mock.patch.object(detector, "available", return_value=False):
            self.assertEqual(self.client.post(f"{self.url}/detect").status_code, 503)


class TemplateMatchingTests(DetectorBase):
    def scene(self) -> np.ndarray:
        rng = np.random.default_rng(5)
        return rng.integers(0, 255, (200, 200, 3), dtype=np.uint8)

    def test_it_finds_the_exemplar_where_it_is_with_the_exemplars_own_size(self) -> None:
        scene = self.scene()
        query = scene[60:100, 80:140].copy()  # 60 wide, 40 high
        shifted = np.roll(scene, (15, -20), axis=(0, 1))  # the object moved 15 down, 20 left
        (box, score), *_ = detector._template_backend(shifted, [query], 1)
        self.assertAlmostEqual(box["x"], 60 / 200, places=3)
        self.assertAlmostEqual(box["y"], 75 / 200, places=3)
        self.assertAlmostEqual(box["w"], 60 / 200, places=3)  # never the size of anything else
        self.assertAlmostEqual(box["h"], 40 / 200, places=3)
        self.assertGreater(score, 0.99)

    def test_the_score_is_absolute_so_a_missing_object_scores_low(self) -> None:
        scene = self.scene()
        query = scene[60:100, 80:140].copy()
        other = np.random.default_rng(9).integers(0, 255, (200, 200, 3), dtype=np.uint8)
        found = detector._template_backend(other, [query], 1)
        self.assertLess(found[0][1], 0.5)

    def test_several_peaks_are_separate_places(self) -> None:
        scene = np.full((200, 200, 3), 100, np.uint8)
        query = self.scene()[:30, :30].copy()
        scene[10:40, 10:40] = query
        scene[120:150, 140:170] = query
        found = detector._template_backend(scene, [query], 2)
        places = sorted((round(b["x"] * 200), round(b["y"] * 200)) for b, _ in found)
        self.assertEqual(places, [(10, 10), (140, 120)])

    def test_a_flat_picture_does_not_break_it(self) -> None:
        flat = np.full((100, 100, 3), 50, np.uint8)
        self.assertEqual(detector._template_backend(flat, [flat[:20, :20].copy()], 1), [])

    def test_an_exemplar_larger_than_the_frame_is_skipped(self) -> None:
        self.assertEqual(detector._template_backend(np.zeros((20, 20, 3), np.uint8), [np.zeros((30, 30, 3), np.uint8)], 1), [])

    def test_run_stores_template_detections_without_a_model(self) -> None:
        rng = np.random.default_rng(2)
        for name in self.frames:  # textured frames: a flat exemplar cannot be matched
            cv2.imwrite(str(datamodel.unsorted_dir("camA") / name), rng.integers(0, 255, (40, 60, 3), dtype=np.uint8))
        ingest.rebuild_index("camA")
        self.client.put(self.url, json={"detector": {"exemplars": [EXEMPLAR], "threshold": 0.5}})
        with (
            mock.patch.object(detector, "available", return_value=False),
            mock.patch.object(detector, "model_cached", return_value=False),
        ):
            result = detector.run("camA", "seal")
        self.assertEqual(result["detected"] + result["skipped_human"], 3)
        stored = detections.load("camA", "seal")
        self.assertEqual(len(stored), 3)
        for rows in stored.values():
            self.assertEqual(rows[0]["status"], "auto")


class ModelBoxSizeTests(DetectorBase):
    def test_a_huge_model_box_becomes_the_exemplars_size_around_its_centre(self) -> None:
        box = detector.sized_like_exemplar((0, 0, 200, 100), exemplar=(40, 20), crop=(200, 100))  # the model boxed the whole frame
        self.assertEqual(box, {"x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2})

    def test_the_box_stays_inside_the_crop(self) -> None:
        box = detector.sized_like_exemplar((180, 90, 200, 100), exemplar=(40, 20), crop=(200, 100))  # a corner
        self.assertEqual(box, {"x": 0.8, "y": 0.8, "w": 0.2, "h": 0.2})
        box = detector.sized_like_exemplar((0, 0, 10, 10), exemplar=(40, 20), crop=(200, 100))
        self.assertEqual((box["x"], box["y"]), (0.0, 0.0))

    def test_an_exemplar_bigger_than_the_crop_is_limited_to_it(self) -> None:
        box = detector.sized_like_exemplar((10, 10, 20, 20), exemplar=(300, 300), crop=(200, 100))
        self.assertEqual((box["x"], box["y"], box["w"], box["h"]), (0.0, 0.0, 1.0, 1.0))


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
        self.assertEqual(queue["counts"], listing["counts"])  # counts cover every frame
        self.assertEqual(queue["counts"]["trusted"], 1)
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


class FilterBeforeDetectionTests(DetectorBase):
    """The feature's pre-processing filter is applied to every frame and to the exemplars before anything is detected."""

    FILTER = {"name": "gaussian", "params": {"sigma": 2.0}}

    def textured(self) -> None:
        rng = np.random.default_rng(4)
        for name in self.frames:
            cv2.imwrite(str(datamodel.unsorted_dir("camA") / name), rng.integers(0, 255, (40, 60, 3), dtype=np.uint8))
        ingest.rebuild_index("camA")

    def record(self, method: str, filter_: dict | None):
        self.textured()
        body = {"detector": {"exemplars": [EXEMPLAR], "topk": 1, "threshold": 0.3, "method": method}}
        if filter_:
            body["filter"] = filter_
        self.assertEqual(self.client.put(self.url, json=body).status_code, 200)
        seen: list[tuple[np.ndarray, list[np.ndarray]]] = []

        def backend(target, queries, topk):
            seen.append((target.copy(), [q.copy() for q in queries]))
            return [(box_at(0.4, 0.4), 0.9)]

        detector.set_backend(backend)
        detector.run("camA", "seal")
        return seen

    def crop(self, frame: str, apply_filter: bool) -> np.ndarray:
        import curation  # noqa: PLC0415
        import preprocess  # noqa: PLC0415

        roi = engine.resolve_roi("camA", "seal")
        crop = roi.crop(curation.load_image(datamodel.unsorted_dir("camA") / frame))
        return preprocess.apply(crop, self.FILTER["name"], self.FILTER["params"]) if apply_filter else crop

    def test_frames_and_exemplars_reach_the_detector_filtered(self) -> None:
        seen = self.record("template", self.FILTER)
        self.assertEqual(len(seen), 3)
        for (target, queries), frame in zip(seen, self.frames):
            self.assertTrue(np.array_equal(target, self.crop(frame, True)))
            self.assertFalse(np.array_equal(target, self.crop(frame, False)))  # it really is not the raw crop
        exemplar = seen[0][1][0]
        raw = self.crop(EXEMPLAR["frame"], False)
        h, w = raw.shape[:2]
        b = EXEMPLAR["box"]
        raw_exemplar = raw[int(b["y"] * h) : int((b["y"] + b["h"]) * h), int(b["x"] * w) : int((b["x"] + b["w"]) * w)]
        filtered = self.crop(EXEMPLAR["frame"], True)
        self.assertTrue(np.array_equal(exemplar, filtered[int(b["y"] * h) : int((b["y"] + b["h"]) * h), int(b["x"] * w) : int((b["x"] + b["w"]) * w)]))
        self.assertFalse(np.array_equal(exemplar, raw_exemplar))

    def test_the_model_method_gets_the_same_filtered_crops(self) -> None:
        seen = self.record("model", self.FILTER)
        for (target, _), frame in zip(seen, self.frames):
            self.assertTrue(np.array_equal(target, self.crop(frame, True)))

    def test_without_a_filter_the_raw_crops_are_used_and_the_signature_follows_the_filter(self) -> None:
        seen = self.record("template", None)
        for (target, _), frame in zip(seen, self.frames):
            self.assertTrue(np.array_equal(target, self.crop(frame, False)))
        raw_sig = vision_settings.detection_signature(vision_settings.get("camA", "seal"))
        self.record("template", self.FILTER)
        self.assertNotEqual(vision_settings.detection_signature(vision_settings.get("camA", "seal")), raw_sig)  # a new filter makes the stored detections stale


class RestoreTests(DetectorBase):
    """Undo of a review decision: the frame's detections come back as they were."""

    def rows(self, frame: str) -> list[dict]:
        return detections.load("camA", "seal").get(self.hash_of(frame), [])

    def test_undoing_an_accept_brings_back_the_auto_candidates_with_the_current_signature(self) -> None:
        self.save()
        detector.set_backend(StubBackend([[(box_at(0.4, 0.4), 0.9), (box_at(0.1, 0.1), 0.5)]]))
        detector.run("camA", "seal")
        before = [{k: r[k] for k in ("x", "y", "w", "h", "conf", "status")} for r in self.rows(self.frames[0])]
        self.assertEqual(len(before), 2)
        self.client.put(f"{self.url}/detections/{self.frames[0]}", json={"box": box_at(0.4, 0.4), "status": "reviewed"})
        self.assertEqual([r["status"] for r in self.rows(self.frames[0])], ["reviewed"])
        r = self.client.post(f"{self.url}/detections/{self.frames[0]}/restore", json={"rows": before})
        self.assertEqual(r.status_code, 200, r.text)
        after = self.rows(self.frames[0])
        self.assertEqual([{k: x[k] for k in ("x", "y", "w", "h", "conf", "status")} for x in after], before)
        sig = vision_settings.detection_signature(vision_settings.get("camA", "seal"))
        self.assertEqual({x["sig"] for x in after}, {sig})  # valid again: shown as the detector's own result

    def test_undoing_a_clear_restores_a_human_decision_and_an_empty_list_clears(self) -> None:
        self.save()
        box = {"x": 0.3, "y": 0.3, "w": 0.2, "h": 0.2}
        self.client.put(f"{self.url}/detections/{self.frames[1]}", json={"box": box, "status": "manual"})
        self.client.delete(f"{self.url}/detections/{self.frames[1]}")
        self.assertEqual(self.rows(self.frames[1]), [])
        self.client.post(f"{self.url}/detections/{self.frames[1]}/restore", json={"rows": [{**box, "conf": 1.0, "status": "manual"}]})
        self.assertEqual([r["status"] for r in self.rows(self.frames[1])], ["manual"])
        self.client.post(f"{self.url}/detections/{self.frames[1]}/restore", json={"rows": []})
        self.assertEqual(self.rows(self.frames[1]), [])

    def test_bad_input_is_refused(self) -> None:
        self.save()
        bad = self.client.post(f"{self.url}/detections/{self.frames[0]}/restore", json={"rows": [{**box_at(0.1, 0.1), "status": "magic"}]})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(self.client.post(f"{self.url}/detections/nope.png/restore", json={"rows": []}).status_code, 404)


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


class FreezeSnapshotTests(DetectorBase):
    def freeze(self) -> dict:
        r = self.client.post("/api/cameras/camA/versions", json={"feature": "seal", "name": "one"})
        self.assertEqual(r.status_code, 201, r.text)
        versions = self.client.get("/api/cameras/camA/versions", params={"feature": "seal"}).json()["versions"]
        return versions[-1]["stats"]

    def test_unconfigured_feature_has_no_vision_snapshot(self) -> None:
        self.assertNotIn("vision", self.freeze())

    def test_freeze_records_settings_signature_and_trusted_boxes(self) -> None:
        self.save()
        detector.set_backend(StubBackend([[(box_at(0.4, 0.4), 0.9)], [(box_at(0.6, 0.6), 0.1)]]))
        detector.run("camA", "seal")
        vision = self.freeze()["vision"]
        self.assertEqual(vision["mask"]["shape"], RECT)
        self.assertEqual(vision["detector"]["exemplars"][0]["frame"], "frame_000.png")
        self.assertEqual(vision["signature"], vision_settings.signature("camA", "seal"))
        # the confident box and nothing else (frames 1 and 2 are below the threshold)
        self.assertEqual(list(vision["detections"]), [self.hash_of(self.frames[0])])

    def test_snapshot_is_frozen_not_live(self) -> None:
        self.save()
        first = self.freeze()["vision"]["signature"]
        self.save(mask={"enabled": True, "shape": {**RECT, "w": 0.4}})
        self.assertNotEqual(vision_settings.signature("camA", "seal"), first)
        versions = self.client.get("/api/cameras/camA/versions", params={"feature": "seal"}).json()["versions"]
        self.assertEqual(versions[0]["stats"]["vision"]["signature"], first)


class ModelDownloadTests(DetectorBase):
    """The model is never downloaded without the user's confirmation."""

    def test_info_reports_whether_the_model_is_on_disk(self) -> None:
        with mock.patch.object(detector, "model_cached", return_value=False):
            info = self.client.get("/api/vision/detector").json()
        self.assertFalse(info["model_cached"])
        self.assertEqual(info["download_mb"], detector.MODEL_DOWNLOAD_MB)
        self.assertEqual(info["download_source"], "huggingface.co")
        with mock.patch.object(detector, "model_cached", return_value=True):
            self.assertTrue(self.client.get("/api/vision/detector").json()["model_cached"])

    def test_detect_needs_confirmation_when_the_model_is_missing(self) -> None:
        self.save()
        with (
            mock.patch.object(detector, "available", return_value=True),
            mock.patch.object(detector, "model_cached", return_value=False),
            mock.patch.object(detector, "run", return_value={}) as run,
        ):
            r = self.client.post(f"{self.url}/detect")
            self.assertEqual(r.status_code, 409)
            self.assertIn("not downloaded", r.json()["detail"])
            ok = self.client.post(f"{self.url}/detect", json={"accept_download": True})
            self.assertEqual(ok.status_code, 200)
            wait_for_job(self.client, ok.json()["id"])
        self.assertEqual(run.call_args.kwargs["allow_download"], True)

    def test_cached_model_runs_without_confirmation(self) -> None:
        self.save()
        with (
            mock.patch.object(detector, "available", return_value=True),
            mock.patch.object(detector, "model_cached", return_value=True),
            mock.patch.object(detector, "run", return_value={}),
        ):
            self.assertEqual(self.client.post(f"{self.url}/detect").status_code, 200)

    def test_run_refuses_to_download_unconfirmed_and_reports_download_when_confirmed(self) -> None:
        self.save()
        with mock.patch.object(detector, "model_cached", return_value=False):
            with self.assertRaisesRegex(detector.DetectorError, "not downloaded"):
                detector.run("camA", "seal")
            phases: list[dict] = []
            with (
                mock.patch.object(detector, "_load_owl") as load,
                mock.patch.object(detector, "_owl_backend", StubBackend([[(box_at(0.4, 0.4), 0.9)]])),
            ):
                detector.run("camA", "seal", phases.append, allow_download=True)
        load.assert_called_once()
        self.assertEqual(phases[0], {"phase": "downloading"})


class BatchingTests(DetectorBase):
    """The default backend takes frames in batches; a replacement backend still takes them one at a time."""

    def run_default(self, batch: int, **detector_settings) -> tuple[dict, list[int]]:
        sizes: list[int] = []
        self.sizes_seen: list[int] = []

        def fake_batch(crops, queries, topk, size=detector.INPUT_SIZE):
            sizes.append(len(crops))
            self.sizes_seen.append(size)
            return [[(box_at(0.4, 0.4), 0.9)] for _ in crops]

        self.save(detector={"exemplars": [EXEMPLAR], "topk": 2, "threshold": 0.3, "method": "model", **detector_settings})
        with (
            mock.patch.object(detector, "model_cached", return_value=True),
            mock.patch.object(detector, "_load_owl"),
            mock.patch.object(detector, "_owl_backend_batch", fake_batch),
            mock.patch.object(detector, "BATCH", batch),
        ):
            return detector.run("camA", "seal"), sizes

    def test_frames_go_to_the_default_backend_in_batches(self) -> None:
        result, sizes = self.run_default(batch=2)
        self.assertEqual(sizes, [2, 1])  # three frames, batches of two
        self.assertEqual(result["detected"], 3)

    def test_the_chosen_input_size_reaches_the_backend_and_defaults_to_the_models_own(self) -> None:
        self.run_default(batch=8)
        self.assertEqual(self.sizes_seen, [768])
        self.run_default(batch=8, size=512)
        self.assertEqual(self.sizes_seen, [512])

    def test_one_batch_when_it_is_big_enough_and_progress_still_reaches_the_total(self) -> None:
        phases: list[dict] = []
        self.save()
        with (
            mock.patch.object(detector, "model_cached", return_value=True),
            mock.patch.object(detector, "_load_owl"),
            mock.patch.object(detector, "_owl_backend_batch", lambda crops, q, k, size=detector.INPUT_SIZE: [[] for _ in crops]),
        ):
            result = detector.run("camA", "seal", phases.append)
        self.assertEqual(result["detected"], 3)
        self.assertEqual(result["needs_review"], 3)  # nothing found
        self.assertEqual(phases[-1], {"done": 3, "total": 3})

    def test_a_replacement_backend_is_called_once_per_frame(self) -> None:
        self.save()
        stub = StubBackend([[(box_at(0.4, 0.4), 0.9)]])
        detector.set_backend(stub)
        with mock.patch.object(detector, "_owl_backend_batch") as batch:
            detector.run("camA", "seal")
        self.assertEqual(stub.calls, 3)
        batch.assert_not_called()


class NonMaximumSuppressionTests(DetectorBase):
    def test_a_weaker_box_overlapping_a_kept_one_is_suppressed_and_distant_ones_survive(self) -> None:
        boxes = np.array([[0, 0, 10, 10], [1, 1, 11, 11], [50, 50, 60, 60]], dtype=np.float32)
        scores = np.array([0.9, 0.8, 0.5], dtype=np.float32)
        kept = detector._boxes_above_nms(scores, boxes)
        self.assertEqual(kept.tolist(), [np.float32(0.9), 0.0, np.float32(0.5)])
        self.assertEqual(scores.tolist(), [np.float32(0.9), np.float32(0.8), np.float32(0.5)])  # the input is untouched

    def test_suppression_stops_once_enough_boxes_survive_and_drops_the_rest(self) -> None:
        boxes = np.array([[0, 0, 10, 10], [20, 20, 30, 30], [40, 40, 50, 50], [60, 60, 70, 70]], dtype=np.float32)
        scores = np.array([0.9, 0.8, 0.7, 0.6], dtype=np.float32)
        self.assertEqual(detector._boxes_above_nms(scores, boxes, keep=2).tolist(), [np.float32(0.9), np.float32(0.8), 0.0, 0.0])
        self.assertEqual((detector._boxes_above_nms(scores, boxes) > 0).sum(), 4)  # the default keeps up to NMS_KEEP

    def test_stopping_early_gives_the_same_best_boxes_as_full_suppression(self) -> None:
        rng = np.random.default_rng(0)
        centres = rng.uniform(0.1, 0.9, (576, 2)).astype(np.float32)
        boxes = np.concatenate([centres - 0.05, centres + 0.05], axis=1)
        scores = rng.uniform(0.01, 1.0, 576).astype(np.float32)
        full = detector._boxes_above_nms(scores, boxes, keep=10_000)
        early = detector._boxes_above_nms(scores, boxes)
        best = np.argsort(-full)[: detector.NMS_KEEP]
        self.assertEqual(sorted(np.flatnonzero(early).tolist()), sorted(best.tolist()))
        self.assertEqual(early[best].tolist(), full[best].tolist())

    def test_zero_scores_are_skipped(self) -> None:
        boxes = np.array([[0, 0, 10, 10], [0, 0, 10, 10]], dtype=np.float32)
        kept = detector._boxes_above_nms(np.array([0.0, 0.7], dtype=np.float32), boxes)
        self.assertEqual(kept.tolist(), [0.0, np.float32(0.7)])


class MaskReachesEmbeddingsTests(DetectorBase):
    """Dedup, scatter and suggestions all embed through ``dedup.fetch_embeddings``."""

    def test_enabled_mask_changes_the_embedded_crops(self) -> None:
        def fake_embed(cutouts, backbone, batch_size=None):
            yield 0, np.array([c.reshape(-1, 3).mean(axis=0) for c in cutouts], dtype=np.float32)

        def embeddings():
            with (
                mock.patch("embedding.backbones", return_value=["fake"]),
                mock.patch("embedding.iter_embed_batches", side_effect=fake_embed),
            ):
                return dedup.fetch_embeddings("camA", "seal", self.frames, "fake")[1]

        import dedup  # noqa: PLC0415

        self.save(mask={"enabled": False, "shape": RECT}, detector=None)
        plain = embeddings()
        self.save(mask={"enabled": True, "shape": RECT}, detector=None)
        masked = embeddings()
        self.assertEqual(plain.shape, masked.shape)
        self.assertFalse(np.allclose(plain, masked))
