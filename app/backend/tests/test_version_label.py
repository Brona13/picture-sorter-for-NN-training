"""Version numbers are written V01, V02 ... (v1.161.0); what was made before keeps its old name."""
from __future__ import annotations

import datamodel
import versions
import ds_export
from vlabel import label

from tests.api_helpers import ApiTestCase


class VersionLabelTests(ApiTestCase):
    def test_label_has_two_digits_at_least_and_a_capital_v(self):
        self.assertEqual([label(n) for n in (1, 9, 10, 99, 100)], ["V01", "V09", "V10", "V99", "V100"])

    def test_names_made_from_the_number_follow_it(self):
        self.assertEqual(ds_export.build_name(" Round one ", 1), "Round one_V01")
        self.assertEqual(ds_export.build_name("Round one", 12), "Round one_V12")

    def test_new_export_folder_uses_the_new_label(self):
        d = versions.export_dir("camA", 3, "my set")
        self.assertEqual(d.name, "V03__my-set")

    def test_an_export_folder_made_before_stays_the_one_found(self):
        old = datamodel.camera_dir("camA") / "exports" / "project" / "v003__my-set"
        old.mkdir(parents=True)
        self.assertEqual(versions.export_dir("camA", 3, "my set"), old)
        self.assertEqual(versions.export_dir("camA", 4, "my set").name, "V04__my-set")
