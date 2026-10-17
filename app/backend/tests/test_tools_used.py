"""Which tools have left a trace on a camera: stored state, plus labels and deletes stamped with the tool."""
from __future__ import annotations

import datamodel
import db
import edge_angle
import labels
import motion
import tools_used
import verdicts
import vision_settings
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM, FEAT = "camA", "seal"
LINE = {"p1": {"x": 0.1, "y": 0.5}, "p2": {"x": 0.9, "y": 0.5}}


class ToolsUsedTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames(CAM, 6)

    def used(self) -> dict[str, bool]:
        return tools_used.used(CAM)

    def on(self) -> set[str]:
        return {k for k, v in self.used().items() if v}

    def test_a_camera_without_rois_has_used_nothing(self) -> None:
        self.assertEqual(set(self.used()), set(tools_used.TOOLS))
        self.assertEqual(self.on(), set())

    def test_having_an_roi_means_the_roi_editor_is_used_and_nothing_else(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        self.assertEqual(self.on(), {"roi"})

    def test_tools_that_store_settings_or_results(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        edge_angle.put(CAM, FEAT, LINE)
        self.assertEqual(self.on(), {"roi", "edge-angle"})
        motion.put(CAM, FEAT, {"source": "auto"})
        self.assertEqual(self.on(), {"roi", "edge-angle", "augmentation"})
        vision_settings.put(CAM, FEAT, {"filter": {"name": "gaussian", "params": {"sigma": 1.5}}})
        self.assertEqual(self.on(), {"roi", "edge-angle", "augmentation", "detector"})

    def test_muting_frames_makes_clusters_used(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        db.add_dedup_mutes(CAM, FEAT, [(self.frames[0], "h", 0)])
        self.assertEqual(self.on(), {"roi", "dedup/clusters"})

    def test_labels_made_in_classify_count_for_classify_only(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        labels.set_label(CAM, FEAT, self.frames[0], "OK")
        self.assertEqual(self.on(), {"roi", "classify"})

    def test_a_label_stamped_with_a_tool_counts_for_that_tool_not_for_classify(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        labels.set_label(CAM, FEAT, self.frames[0], "OK", via="Outliers")
        self.assertEqual(self.on(), {"roi", "dedup/outliers"})
        labels.set_label(CAM, FEAT, self.frames[1], "OK", via="Insights")
        labels.set_label(CAM, FEAT, self.frames[2], "NG", via="Scatter")
        labels.set_label(CAM, FEAT, self.frames[3], "NG", via="Clusters")
        self.assertEqual(self.on(), {"roi", "dedup/outliers", "insights", "dedup/scatter", "dedup/clusters"})

    def test_the_old_dedup_stamp_of_the_scatter_selection_still_counts_for_scatter(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        labels.set_labels_bulk(CAM, FEAT, self.frames[:2], "OK", via="Dedup")
        self.assertEqual(self.on(), {"roi", "dedup/scatter"})

    def test_a_delete_counts_for_the_tool_it_was_made_from(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        r = self.client.post(f"/api/cameras/{CAM}/classify/delete", json={"feature": FEAT, "frame": self.frames[0], "via": "Scatter"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.on(), {"roi", "dedup/scatter"})
        r = self.client.post(f"/api/cameras/{CAM}/classify/delete-bulk", json={"feature": FEAT, "frames": [self.frames[1]], "via": "Insights"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.on(), {"roi", "dedup/scatter", "insights"})

    def test_a_delete_without_a_tool_is_a_classify_action(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        self.client.post(f"/api/cameras/{CAM}/classify/delete", json={"feature": FEAT, "frame": self.frames[0]})
        self.assertEqual(self.on(), {"roi", "classify"})

    def test_the_label_endpoint_stamps_the_tool(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        r = self.client.put(f"/api/cameras/{CAM}/classify/label", json={"feature": FEAT, "frame": self.frames[0], "cls": "OK", "via": "Outliers"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("dedup/outliers", self.on())
        self.assertNotIn("classify", self.on())

    def test_a_verdict_decision_makes_verdict_used(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        verdicts.decide(CAM, self.frames[0], "OK")
        self.assertIn("verdict", self.on())

    def test_the_endpoint_returns_the_same_answer(self) -> None:
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        r = self.client.get(f"/api/cameras/{CAM}/tools-used")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), self.used())
        self.assertEqual(self.client.get("/api/cameras/nope/tools-used").status_code, 404)
