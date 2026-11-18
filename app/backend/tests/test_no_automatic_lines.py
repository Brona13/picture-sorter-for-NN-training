"""Placing a box never draws a line, and a deleted Classifier leaves nothing behind for the next one of the same name.

The user draws every line himself. A new Classifier is named after the lowest free number (``classifier``, ``classifier 2``), so
after a delete the next one gets the old name back: whatever the old one stored under that name must be gone, or the new
Classifier arrives with a line (a Dedup box it read through, a class-dot line, its detached flag, its layout)."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

import config  # noqa: F401  (tests.api_helpers points it at temp dirs)
import datamodel
import dedup_box
import flow
import class_lines
import db
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camA"
ALL_FLOW_KINDS = ["crop", "detector", "calc", "evaluation", "dedup", "export", "merge"]


class NoAutomaticLinesTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        write_frames(CAM, 4)
        self.base = f"/api/cameras/{CAM}"

    def canvas(self) -> dict:
        r = self.client.get(f"{self.base}/chain")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def edges(self) -> set[tuple]:
        return {(e["source"], e["source_handle"], e["target"]) for e in self.canvas()["edges"]}

    def place_classifier(self, name: str) -> str:
        """The calls the Chain page makes for the Classifier tile (``addFeature``)."""
        r = self.client.put(f"{self.base}/rois", json={"name": name, "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5})
        self.assertEqual(r.status_code, 200, r.text)
        feature = r.json()["feature"]
        self.assertEqual(self.client.put(f"{self.base}/chain/{feature}/detached", json={"detached": True}).status_code, 200)
        self.assertEqual(self.client.put(f"{self.base}/rois/{feature}/region", json={"mode": "as_is"}).status_code, 200)
        return feature

    def place_box(self, kind: str) -> str:
        r = self.client.post(f"{self.base}/flow/nodes", json={"kind": kind, "step": 1})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def test_no_box_comes_with_a_line_whatever_was_placed_before(self) -> None:
        self.assertEqual(self.edges(), set())
        self.place_classifier("classifier")
        self.assertEqual(self.edges(), set())
        for kind in ALL_FLOW_KINDS:
            self.place_box(kind)
            self.assertEqual(self.edges(), set(), f"a {kind} box came with a line")
        self.place_classifier("classifier 2")
        self.assertEqual(self.edges(), set())

    def test_place_several_delete_some_and_place_new_ones_never_gives_a_line(self) -> None:
        placed = [self.place_box(k) for k in ["detector", "dedup", "calc", "dedup", "crop"]]
        c1, c2, c3 = (self.place_classifier(n) for n in ["classifier", "classifier 2", "classifier 3"])
        for box in placed[1:4]:
            self.assertEqual(self.client.delete(f"{self.base}/flow/nodes/{box}").status_code, 200)
        for feature in (c2, c1):
            self.assertEqual(self.client.delete(f"{self.base}/rois/{feature}").status_code, 200)
        self.assertEqual(self.edges(), set())
        again = [self.place_box(k) for k in ["dedup", "detector", "evaluation"]]
        self.assertFalse(set(again) & set(placed))  # a number is never given twice
        self.assertEqual({self.place_classifier("classifier"), self.place_classifier("classifier 2")}, {c1, c2})  # the names come back
        self.assertEqual(self.edges(), set())
        self.assertEqual(c3, "classifier 3")

    def test_a_new_classifier_with_the_name_of_a_deleted_one_arrives_without_any_line(self) -> None:
        d1 = self.place_box("dedup")
        d2 = self.place_box("dedup")
        feature = self.place_classifier("classifier 2")
        # everything the user can draw into a Classifier
        self.client.put(f"{self.base}/chain/{feature}/detached", json={"detached": False})  # the line from Ingest
        dedup_box.set_input(CAM, feature, d1)  # a Dedup box it reads through
        dedup_box.set_input(CAM, feature, d2, muted=True)  # and the Muted dot of another
        db.set_setting(CAM, f"{db.CLASS_LINES_KEY}{feature}", '[{"class": "OK", "box": "%s"}]' % d1)  # a line into a class dot
        self.assertNotEqual(self.edges(), set())
        db.set_setting(CAM, f"vision.{feature}", "{}")
        db.set_setting(CAM, f"grid.cols.{feature}", "6")
        # delete it and place the next one, which gets the same name
        self.assertEqual(self.client.delete(f"{self.base}/rois/{feature}").status_code, 200)
        self.assertEqual(self.edges(), set())
        again = self.place_classifier("classifier 2")
        self.assertEqual(again, feature)
        self.assertEqual(self.edges(), set(), "the new Classifier inherited a line from the deleted one")
        self.assertEqual(dedup_box.inputs_of(CAM, again), [])
        self.assertEqual(dedup_box.muted_inputs_of(CAM, again), [])
        self.assertEqual(class_lines.get(CAM, again), [])
        for key in (f"vision.{again}", f"grid.cols.{again}"):
            self.assertIsNone(db.get_setting(CAM, key), key)

    def test_leftovers_from_before_the_fix_are_cleared_when_the_name_is_used_again(self) -> None:
        """A database that already holds the settings of a Classifier that no longer exists."""
        flow_id = self.place_box("dedup")
        db.set_setting(CAM, f"{db.DEDUP_INPUT_KEY}classifier 3", flow_id)
        db.set_setting(CAM, f"{db.DEDUP_MUTED_KEY}classifier 3", f'["{flow_id}"]')
        db.set_setting(CAM, f"{db.CLASS_LINES_KEY}classifier 3", '[{"class": "OK", "box": "%s"}]' % flow_id)
        self.assertEqual(datamodel.get_roi(CAM, "classifier 3"), None)
        feature = self.place_classifier("classifier 3")
        self.assertEqual(self.edges(), set())
        self.assertEqual(dedup_box.inputs_of(CAM, feature), [])

    def test_deleting_the_boxes_a_classifier_read_leaves_no_line_for_the_next_box(self) -> None:
        d1 = self.place_box("dedup")
        feature = self.place_classifier("classifier")
        dedup_box.set_input(CAM, feature, d1)
        self.assertEqual(self.client.delete(f"{self.base}/flow/nodes/{d1}").status_code, 200)
        self.assertEqual(dedup_box.inputs_of(CAM, feature), [])
        d2 = self.place_box("dedup")
        self.assertNotEqual(d2, d1)  # a number is never given twice
        self.assertEqual(self.edges(), set())
        self.assertFalse(flow.load_graph(CAM)["edges"])


class EverySettingOfAClassifierIsForgottenTests(unittest.TestCase):
    """A new per-Classifier setting must be added to ``db.FEATURE_SETTING_PREFIXES`` (forgotten with the ROI), or named here as not
    belonging to a Classifier. This is the prevention: forgetting one is how a new Classifier once arrived with the old one's lines."""

    #: settings keyed by something other than a Classifier's name (a box id, a camera-wide value)
    NOT_A_CLASSIFIER = {
        "flow.det.": "results of a detector box (keyed by box id; ids are never reused)",
        "dedup.basis.": "what a Dedup box compared (keyed by box id)",
        "freeze.decisions.": "decisions on a Freeze box (keyed by box id)",
    }

    def test_every_per_name_setting_is_forgotten_or_explained(self) -> None:
        root = Path(__file__).resolve().parents[1]
        found: set[str] = set()
        for path in root.rglob("*.py"):
            if "tests" in path.parts:
                continue
            for m in re.finditer(r"^\s*[A-Z_]*(?:KEY|PREFIX)[A-Z_]*\s*=\s*\"([a-z_.]+\.)\"", path.read_text(encoding="utf-8"), re.M):
                found.add(m.group(1))
        unknown = sorted(p for p in found if p not in db.FEATURE_SETTING_PREFIXES and p not in self.NOT_A_CLASSIFIER)
        self.assertEqual(unknown, [], f"settings keyed by name that nothing forgets when the Classifier is deleted: {unknown}")
