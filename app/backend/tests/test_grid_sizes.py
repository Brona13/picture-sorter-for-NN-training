"""Page sizes are whole rows of the chosen columns."""
from __future__ import annotations

import datamodel
import grid_sizes
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

CAM = "camG"


def test_options_follow_the_columns() -> None:
    assert grid_sizes.per_page_options(6) == [12, 24, 48, 96]
    assert grid_sizes.per_page_options(5) == [10, 20, 40, 80]
    assert grid_sizes.is_valid(20, 5) and not grid_sizes.is_valid(24, 5) and not grid_sizes.is_valid(20, 7)
    assert 24 in grid_sizes.all_per_page() and 96 in grid_sizes.all_per_page()


class GridSettingsApiTests(ApiTestCase):
    def test_classify_and_verdict_settings_take_whole_rows_only(self) -> None:
        write_frames(CAM, 3)
        datamodel.save_rois(CAM, [ROI("seal", 0, 0, 1, 1)])
        url = f"/api/cameras/{CAM}/classify/grid-settings"
        self.assertEqual(self.client.put(url, json={"feature": "seal", "per_page": 20, "cols": 5}).status_code, 200)
        self.assertEqual(self.client.put(url, json={"feature": "seal", "per_page": 24, "cols": 5}).status_code, 422)
        verdict = f"/api/cameras/{CAM}/verdicts/grid-settings"
        self.assertEqual(self.client.put(verdict, json={"per_page": 40, "cols": 5}).status_code, 200)
        self.assertEqual(self.client.put(verdict, json={"per_page": 12, "cols": 5}).status_code, 422)
