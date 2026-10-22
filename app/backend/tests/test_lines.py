"""Line types and the frame-set rule of a classifier dot (temporary roots only)."""
from __future__ import annotations

import cv2
import numpy as np

import datamodel
import db
import flow
import ingest
import labels
import lines
from roi import ROI
from tests.api_helpers import ApiTestCase

CAM = "camL"


class LineTypeTests(ApiTestCase):
    def test_fitting_pairs(self) -> None:
        for source, target in [("ingest", "crop"), ("crop", "detector"), ("detector", "calc"), ("calc", "evaluation"), ("ingest", "roi")]:
            self.assertIsNone(lines.line_error(source, target), (source, target))

    def test_mismatch_gives_a_reason(self) -> None:
        reason = lines.line_error("crop", "calc")
        self.assertIn("Picture edits gives a picture", reason)
        self.assertIn("Calculate takes a target point", reason)
        self.assertIn("takes no line", lines.line_error("crop", "ingest"))
        self.assertIn("gives nothing", lines.line_error("nothing", "crop"))

    def test_a_dot_can_carry_one_type(self) -> None:
        self.assertIsNone(lines.line_error("detector", "calc", lines.POINT))
        self.assertIsNotNone(lines.line_error("detector", "evaluation", lines.POINT))

    def test_flow_refuses_with_the_reason(self) -> None:
        graph = {"nodes": {}, "edges": []}
        self.assertIn("takes", flow.edge_allowed(graph, "calc:1", "crop:1") or "")
        self.assertIn("takes", flow.edge_allowed(graph, "crop:1", "calc:1") or "")


class FrameSetTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        datamodel.ensure_camera_dirs(CAM)
        self.names = []
        for i in range(6):
            name = f"f{i}.png"
            cv2.imwrite(str(datamodel.unsorted_dir(CAM) / name), np.full((20, 20, 3), i * 30, np.uint8))
            self.names.append(name)
        ingest.rebuild_index(CAM)
        datamodel.save_rois(CAM, [ROI(name="shape", x=0, y=0, w=1, h=1, role="classify", classes=["A", "B"])])
        for name, cls in zip(self.names[:4], ["A", "A", "B", "B"]):  # the last two stay unlabelled
            labels.set_label(CAM, "shape", name, cls)

    def test_all_dot_passes_only_classified_frames(self) -> None:
        self.assertEqual(sorted(lines.frames_on_dot(CAM, "shape", lines.ALL_DOT)), self.names[:4])

    def test_class_dot_passes_its_class(self) -> None:
        self.assertEqual(sorted(lines.frames_on_dot(CAM, "shape", "A")), self.names[:2])
        self.assertEqual(sorted(lines.frames_on_dot(CAM, "shape", "B")), self.names[2:4])

    def test_unknown_class_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            lines.frames_on_dot(CAM, "shape", "Z")

    def test_deleted_and_muted_frames_do_not_pass(self) -> None:
        db.mark_frames_deleted(CAM, [(self.names[0], db.frame_hash_for(CAM, self.names[0]))])
        db.add_dedup_mutes(CAM, "shape", [(self.names[1], db.frame_hash_for(CAM, self.names[1]), 1)])
        self.assertEqual(lines.frames_on_dot(CAM, "shape", "A"), [])
        self.assertEqual(sorted(lines.frames_on_dot(CAM, "shape", lines.ALL_DOT)), self.names[2:4])
