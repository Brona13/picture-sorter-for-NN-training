"""Smoke tests for the view modules touched by the refactor plan.

These are intentionally narrow: they assert that (a) each view module
imports cleanly against a temp data root, (b) the session-state key
conventions the views share (notably ``classify::<camera>::<feature>``)
stay in agreement across their producers and consumers, and (c) a
handful of domain-level state transitions ``BEHAVIOR_INVENTORY.md`` §§8–9
depend on still hold.

Full Streamlit UI harnessing is out of scope: these run without a
``ScriptRunContext``, so anything that mutates ``st.session_state`` or
renders widgets is exercised through the underlying helpers rather than
by driving Streamlit itself.
"""
from __future__ import annotations

import importlib
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import config
import datamodel
import db
import labels
from roi import ROI


VIEW_MODULES = [
    "view_status",
    "view_ingest",
    "view_roi_editor",
    "view_roi_editor.render",
    "view_dedup",
    "view_classify",
    "view_classify.render",
    "view_classify._helpers",
    "view_insights",
    "view_versions",
]


class ViewModulesImportTests(unittest.TestCase):
    """Every view module the refactor plan touches must import without error.

    Streamlit emits a benign "missing ScriptRunContext" warning at import
    time here — that is the documented behavior when Streamlit modules
    are imported outside a running server and is not a failure.
    """

    def test_all_view_modules_import(self) -> None:
        for name in VIEW_MODULES:
            with self.subTest(module=name):
                importlib.import_module(name)


class SessionStateKeyConventionsTests(unittest.TestCase):
    """The keys different views read/write on the shared Streamlit session
    state must agree on their exact shape. Silent drift here is precisely
    the failure mode ``BEHAVIOR_INVENTORY.md`` §10 warns about: the
    Versions Freeze form reads ``classify::<camera>::<feature>`` produced
    (and later popped) by the Classify view. The registry in
    ``session_keys`` owns that convention; these tests lock its exact
    output so refactors can't silently split producer and consumer.
    """

    def test_classify_scored_key_matches_documented_literal(self) -> None:
        import session_keys

        camera = "cam"
        feature = "typeA::rod"
        expected = f"classify::{camera}::{feature}"
        self.assertEqual(expected, session_keys.classify_scored(camera, feature))

    def test_classify_scored_survives_shared_and_composite_features(self) -> None:
        import session_keys

        # A shared camera-level feature — no product prefix.
        self.assertEqual(
            "classify::cam::defects",
            session_keys.classify_scored("cam", "defects"),
        )
        # A product-scoped composite feature.
        self.assertEqual(
            "classify::cam::widgetA::rod",
            session_keys.classify_scored("cam", "widgetA::rod"),
        )

    def test_classify_show_muted_and_insights_matrices_shapes(self) -> None:
        import session_keys

        self.assertEqual(
            "classify::show-muted::cam::front",
            session_keys.classify_show_muted("cam", "front"),
        )
        self.assertEqual(
            "insights::cam::front",
            session_keys.insights_matrices("cam", "front"),
        )


class FeaturePickerCompositionTests(unittest.TestCase):
    """The four view modules all compose their feature-picker list the
    same way: ``list_features_for(camera, product) + [compose_feature(
    product, WHOLE_FRAME_FEATURE)]``. Step 3 will extract this into a
    shared helper; the resulting feature list must stay identical.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"
        self.camera = "cam"
        datamodel.ensure_camera_dirs(self.camera)

    def tearDown(self) -> None:
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        self.tmp.cleanup()

    def test_composed_feature_list_matches_expected_ordering(self) -> None:
        datamodel.save_rois(self.camera, [ROI.full_frame("front")])

        product = None
        expected = datamodel.list_features_for(self.camera, product) + [
            datamodel.compose_feature(product, config.WHOLE_FRAME_FEATURE)
        ]

        self.assertEqual(["front", config.WHOLE_FRAME_FEATURE], expected)

    def test_whole_frame_placeholder_is_always_appended(self) -> None:
        # No ROIs defined — the picker should still surface the whole-frame option.
        picker_items = datamodel.list_features_for(self.camera, product=None) + [
            datamodel.compose_feature(None, config.WHOLE_FRAME_FEATURE)
        ]
        self.assertEqual([config.WHOLE_FRAME_FEATURE], picker_items)


class LabelAndGoldenTransitionTests(unittest.TestCase):
    """The label-click and star/golden toggle paths the Classify view
    depends on. These match the invariants pinned in
    ``BEHAVIOR_INVENTORY.md`` §9: ``set_label`` with a class also updates
    the golden's class; ``clear_label`` removes both label and golden in
    one transaction; ``mark_golden`` upserts both.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"
        self.camera = "cam"
        self.feature = "front"
        self.frame = "f.png"

    def tearDown(self) -> None:
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        self.tmp.cleanup()

    def test_mark_golden_upserts_both_label_and_golden_row(self) -> None:
        labels.mark_golden(self.camera, self.feature, self.frame, "OK")
        self.assertEqual(
            "OK",
            labels.current_label_for_frame(self.camera, self.feature, self.frame),
        )
        self.assertEqual(
            "OK",
            labels.current_golden_for_frame(self.camera, self.feature, self.frame),
        )

    def test_relabeling_a_golden_moves_its_reference_class(self) -> None:
        labels.mark_golden(self.camera, self.feature, self.frame, "OK")
        labels.set_label(self.camera, self.feature, self.frame, "NG", source="test")
        self.assertEqual(
            "NG",
            labels.current_label_for_frame(self.camera, self.feature, self.frame),
        )
        self.assertEqual(
            "NG",
            labels.current_golden_for_frame(self.camera, self.feature, self.frame),
        )

    def test_clear_label_removes_both_label_and_golden(self) -> None:
        labels.mark_golden(self.camera, self.feature, self.frame, "OK")
        labels.clear_label(self.camera, self.feature, self.frame)
        self.assertIsNone(
            labels.current_label_for_frame(self.camera, self.feature, self.frame)
        )
        self.assertIsNone(
            labels.current_golden_for_frame(self.camera, self.feature, self.frame)
        )


class DedupMuteStateTransitionsTests(unittest.TestCase):
    """The Dedup apply/clear flow ultimately writes and reads through
    ``db.add_dedup_mutes`` / ``db.add_dedup_unmutes`` / ``db.muted_frames``
    / ``db.clear_dedup_mutes``. Step 5 splits the view but must preserve
    this state machine end-to-end.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old_data = config.DATA_DIR
        self.old_cameras = config.CAMERAS_ROOT
        config.DATA_DIR = root / "data"
        config.CAMERAS_ROOT = root / "cameras"
        self.camera = "cam"
        self.feature = "front"

    def tearDown(self) -> None:
        config.DATA_DIR = self.old_data
        config.CAMERAS_ROOT = self.old_cameras
        self.tmp.cleanup()

    def test_apply_then_unmute_then_clear_roundtrip(self) -> None:
        entries = [("a.png", "hashA", 1), ("b.png", "hashB", 1), ("c.png", "hashC", 2)]
        self.assertEqual(3, db.add_dedup_mutes(self.camera, self.feature, entries))
        self.assertEqual({"a.png", "b.png", "c.png"}, db.muted_frames(self.camera, self.feature))

        self.assertEqual(1, db.add_dedup_unmutes(self.camera, self.feature, ["b.png"]))
        self.assertEqual({"a.png", "c.png"}, db.muted_frames(self.camera, self.feature))

        self.assertEqual(2, db.clear_dedup_mutes(self.camera, self.feature))
        self.assertEqual(set(), db.muted_frames(self.camera, self.feature))


if __name__ == "__main__":
    unittest.main()
