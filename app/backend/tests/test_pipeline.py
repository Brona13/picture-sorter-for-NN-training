from __future__ import annotations

import datamodel
import db
import edge_angle
import labels
import motion
import pipeline
import vision_settings
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job, write_frames

CAM, FEAT = "camA", "seal"
LINE = {"p1": {"x": 0.1, "y": 0.5}, "p2": {"x": 0.9, "y": 0.5}}


class PipelineTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 6)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])

    def stages(self) -> dict[str, dict]:
        return {s["id"]: s for s in pipeline.stages(CAM, FEAT)["stages"]}

    def status(self) -> dict[str, str]:
        return {i: s["status"] for i, s in self.stages().items()}

    def test_a_fresh_roi_has_only_its_roi_and_labeling_comes_next(self) -> None:
        out = pipeline.stages(CAM, FEAT)
        self.assertEqual(out["next"], "labeled")
        self.assertEqual((out["frames"], out["labeled"]), (6, 0))
        st = self.status()
        self.assertEqual(st["roi"], "done")
        self.assertTrue(all(v == "todo" for k, v in st.items() if k != "roi"))
        self.assertEqual([s["id"] for s in out["stages"]], [s[0] for s in pipeline.STAGES])
        self.assertEqual({s["id"] for s in out["stages"] if s["optional"]}, {"vision", "dedup", "edge", "augment"})

    def test_each_stage_names_the_page_that_does_it(self) -> None:
        views = {s["id"]: s["view"] for s in pipeline.stages(CAM, FEAT)["stages"]}
        self.assertEqual(
            views,
            {"roi": "roi", "vision": "detector", "dedup": "dedup", "labeled": "classify", "goldens": "classify", "scored": "classify",
             "edge": "edge-angle", "augment": "augmentation", "version": "versions", "exported": "versions"},
        )

    def test_labels_are_partial_until_every_class_has_one_and_goldens_follow_the_labels(self) -> None:
        labels.set_label(CAM, FEAT, self.frames[0], "OK")
        self.assertEqual(self.status()["labeled"], "partial")
        self.assertEqual(self.stages()["labeled"]["detail"], "1 of 6 · OK 1 · NG 0")
        labels.set_label(CAM, FEAT, self.frames[1], "NG")
        self.assertEqual(self.status()["labeled"], "done")
        self.assertEqual(pipeline.stages(CAM, FEAT)["next"], "goldens")
        labels.mark_golden(CAM, FEAT, self.frames[0], "OK")
        self.assertEqual(self.status()["goldens"], "partial")
        labels.mark_golden(CAM, FEAT, self.frames[1], "NG")
        self.assertEqual(self.status()["goldens"], "done")
        self.assertEqual(self.stages()["goldens"]["detail"], "OK 1 · NG 1")
        self.assertEqual(pipeline.stages(CAM, FEAT)["next"], "scored")

    def scored(self) -> None:
        r = self.client.post(f"/api/cameras/{CAM}/classify/refresh", json={"feature": FEAT})
        self.assertEqual(r.status_code, 202, r.text)
        self.assertEqual(wait_for_job(self.client, r.json()["id"])["status"], "done")

    def golden_pair(self) -> None:
        labels.set_label(CAM, FEAT, self.frames[0], "OK")
        labels.set_label(CAM, FEAT, self.frames[1], "NG")
        labels.mark_golden(CAM, FEAT, self.frames[0], "OK")
        labels.mark_golden(CAM, FEAT, self.frames[1], "NG")

    def test_scores_are_done_after_a_refresh_and_stale_when_goldens_change(self) -> None:
        self.golden_pair()
        self.assertEqual(self.status()["scored"], "todo")
        self.scored()
        self.assertEqual(self.status()["scored"], "done")
        labels.set_label(CAM, FEAT, self.frames[2], "OK")
        labels.mark_golden(CAM, FEAT, self.frames[2], "OK")
        st = self.stages()["scored"]
        self.assertEqual((st["status"], st["detail"]), ("stale", "goldens changed since"))
        self.assertEqual(pipeline.stages(CAM, FEAT)["next"], "scored")  # a stale score is not done

    def test_scores_cannot_be_done_without_goldens(self) -> None:
        self.assertEqual(self.status()["scored"], "todo")

    def test_optional_stages_follow_their_own_state(self) -> None:
        vision_settings.put(CAM, FEAT, {"filter": {"name": "gaussian", "params": {"sigma": 1.5}}})
        self.assertEqual(self.status()["vision"], "done")
        db.add_dedup_mutes(CAM, FEAT, [(self.frames[3], labels.hash_map(CAM)[self.frames[3]], 0)])
        self.assertEqual((self.status()["dedup"], self.stages()["dedup"]["detail"]), ("done", "1 muted"))
        edge_angle.put(CAM, FEAT, LINE)
        st = self.stages()["edge"]
        self.assertEqual((st["status"], st["detail"]), ("partial", "not measured yet"))
        edge_angle.run(CAM, FEAT)
        self.assertEqual(self.status()["edge"], "done")
        edge_angle.put(CAM, FEAT, {**LINE, "points": 6})  # a changed line makes the measurements stale again
        self.assertEqual(self.status()["edge"], "partial")
        motion.put(CAM, FEAT, {"source": "auto"})
        self.assertEqual(self.status()["augment"], "partial")
        motion.put(CAM, FEAT, {"source": "auto", "ranges": {"dx": [-3, 4]}})
        self.assertEqual(self.status()["augment"], "done")

    def test_optional_stages_never_hold_the_pipeline_back(self) -> None:
        self.golden_pair()
        self.scored()
        self.assertEqual(pipeline.stages(CAM, FEAT)["next"], "version")  # vision, dedup, edge, augmentation skipped

    def test_version_and_export_complete_the_pipeline(self) -> None:
        self.golden_pair()
        self.scored()
        r = self.client.post(f"/api/cameras/{CAM}/versions", json={"feature": FEAT, "name": "first", "notes": ""})
        self.assertEqual(r.status_code, 201, r.text)
        st = self.stages()
        self.assertEqual((st["version"]["status"], st["version"]["detail"], st["exported"]["status"]), ("done", "v1", "todo"))
        self.assertEqual(pipeline.stages(CAM, FEAT)["next"], "exported")
        pv = self.client.post(f"/api/cameras/{CAM}/project-versions", json={"name": "first"})
        self.assertEqual(pv.status_code, 201, pv.text)
        self.assertEqual(self.stages()["exported"]["status"], "todo")  # frozen, not exported yet
        exp = self.client.post(f"/api/cameras/{CAM}/project-versions/{pv.json()['id']}/export")
        self.assertEqual(exp.status_code, 200, exp.text)
        self.assertEqual(self.stages()["exported"]["status"], "done")
        self.assertEqual(self.stages()["exported"]["detail"], "project v1")
        self.assertIsNone(pipeline.stages(CAM, FEAT)["next"])

    def test_a_deleted_version_no_longer_counts(self) -> None:
        self.golden_pair()
        first = self.client.post(f"/api/cameras/{CAM}/versions", json={"feature": FEAT, "name": "a", "notes": ""}).json()["id"]
        self.client.post(f"/api/cameras/{CAM}/versions", json={"feature": FEAT, "name": "b", "notes": ""})
        self.client.delete(f"/api/cameras/{CAM}/versions/{first}", params={"feature": FEAT})
        self.assertEqual(self.stages()["version"]["detail"], "v2")


class PipelineApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        write_frames(CAM, 3)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1), ROI(name="cap", x=0, y=0, w=0.5, h=0.5)])

    def test_the_overview_carries_the_pipeline_of_every_roi(self) -> None:
        labels.set_label(CAM, FEAT, "frame_000.png", "OK")
        cam = self.client.get("/api/overview").json()["cameras"][0]
        by = {r["feature"]: r["pipeline"] for r in cam["rois"]}
        self.assertEqual(set(by), {FEAT, "cap"})
        self.assertEqual(by[FEAT]["labeled"], 1)
        self.assertEqual(by[FEAT]["next"], "labeled")
        self.assertEqual(by["cap"]["labeled"], 0)
        self.assertEqual({s["id"]: s["status"] for s in by[FEAT]["stages"]}["labeled"], "partial")

    def test_the_step_bar_endpoint_and_its_errors(self) -> None:
        body = self.client.get(f"/api/cameras/{CAM}/pipeline", params={"feature": FEAT}).json()
        self.assertEqual((body["feature"], body["next"]), (FEAT, "labeled"))
        self.assertEqual(self.client.get(f"/api/cameras/{CAM}/pipeline", params={"feature": "zzz"}).status_code, 404)
        self.assertEqual(self.client.get("/api/cameras/nope/pipeline", params={"feature": FEAT}).status_code, 404)
