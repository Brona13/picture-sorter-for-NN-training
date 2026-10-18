"""The numbers above the Classify grid count the pictures the user works with: not deleted, not muted for the ROI."""
from __future__ import annotations

import config
import datamodel
import db
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase
from tests.test_api_classify import write_two_groups

CAM = "camA"


class ClassifyCountsTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._emb = config.EMBEDDING_ENABLED
        config.EMBEDDING_ENABLED = False
        self.blue, self.red = write_two_groups(CAM)  # 8 pictures
        datamodel.save_rois(CAM, [
            ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"]),
            ROI("seal", 0, 0, 1, 1, products=["A"]),
            ROI("edge", 0, 0, 1, 1),
        ])
        for f in self.blue:
            labels.set_label(CAM, "type", f, "A")
        self.base = f"/api/cameras/{CAM}/classify"

    def tearDown(self) -> None:
        config.EMBEDDING_ENABLED = self._emb
        super().tearDown()

    def state(self, feature: str) -> dict:
        r = self.client.get(f"{self.base}/state", params={"feature": feature})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def counts(self, feature: str) -> dict:
        return self.state(feature)["counts"]

    def delete(self, feature: str, frame: str) -> dict:
        return self.client.post(f"{self.base}/delete", json={"feature": feature, "frame": frame}).json()

    def test_everything_is_live_before_anything_is_hidden(self) -> None:
        c = self.counts("edge")
        self.assertEqual((c["total"], c["unlabeled"]), (8, 8))
        c = self.counts("type")
        self.assertEqual((c["total"], c["A"], c["B"], c["unlabeled"]), (8, 4, 0, 4))

    def test_deleted_pictures_leave_the_numbers(self) -> None:
        self.delete("edge", self.red[0])
        self.delete("edge", self.red[1])
        c = self.counts("edge")
        self.assertEqual((c["total"], c["unlabeled"]), (6, 6))

    def test_deleting_a_labeled_picture_lowers_its_class_count(self) -> None:
        self.assertEqual(self.counts("type")["A"], 4)
        self.delete("type", self.blue[0])
        c = self.counts("type")
        self.assertEqual((c["total"], c["A"], c["unlabeled"]), (7, 3, 4))

    def test_restoring_brings_them_back(self) -> None:
        self.delete("edge", self.red[0])
        self.client.post(f"{self.base}/restore", json={"feature": "edge", "frame": self.red[0]})
        self.assertEqual(self.counts("edge")["total"], 8)

    def test_the_answer_to_an_action_carries_the_live_numbers(self) -> None:
        body = self.delete("edge", self.red[0])
        self.assertEqual((body["counts"]["total"], body["counts"]["unlabeled"]), (7, 7))
        r = self.client.put(f"{self.base}/label", json={"feature": "edge", "frame": self.red[1], "cls": "OK"})
        c = r.json()["counts"]
        self.assertEqual((c["total"], c["OK"], c["unlabeled"]), (7, 1, 6))

    def test_pictures_muted_for_the_roi_leave_its_numbers_only(self) -> None:
        db.add_dedup_mutes(CAM, "edge", [(self.red[0], "", -1), (self.red[1], "", -1)])
        self.assertEqual(self.counts("edge")["total"], 6)
        self.assertEqual(self.counts("type")["total"], 8)  # another ROI is not affected

    def test_a_scoped_roi_counts_only_its_own_live_pictures(self) -> None:
        c = self.counts("seal")  # product A: the 4 blue pictures
        self.assertEqual((c["total"], c["unlabeled"]), (4, 4))
        self.delete("seal", self.blue[0])
        self.assertEqual(self.counts("seal")["total"], 3)

    def test_a_label_on_a_picture_outside_the_scope_is_not_counted(self) -> None:
        labels.set_label(CAM, "seal", self.red[0], "OK")  # red_0 has no product, so seal does not cover it
        c = self.counts("seal")
        self.assertEqual((c["OK"], c["unlabeled"], c["total"]), (0, 4, 4))

    def test_scope_says_whether_the_roi_covers_only_some_products_and_how_many_pictures_the_camera_has(self) -> None:
        self.assertEqual(self.state("seal")["scope"], {"restricted": True, "camera_frames": 8})
        self.assertEqual(self.state("edge")["scope"], {"restricted": False, "camera_frames": 8})
        self.assertEqual(self.state("type")["scope"], {"restricted": False, "camera_frames": 8})
        self.delete("edge", self.red[0])
        self.assertEqual(self.state("seal")["scope"]["camera_frames"], 7)

    def test_a_product_named_roi_is_restricted(self) -> None:
        datamodel.save_rois(CAM, [*datamodel.load_rois(CAM), ROI("A::rod", 0, 0, 1, 1)])
        self.assertTrue(self.state("A::rod")["scope"]["restricted"])

    def test_other_pages_keep_their_numbers(self) -> None:
        """The shared counting function is unchanged: Status and the version records still see every picture."""
        self.delete("edge", self.red[0])
        self.assertEqual(labels.counts(CAM, "edge")["total"], 8)


if __name__ == "__main__":
    import unittest

    unittest.main()
