"""Searching the Classify grid by file name: the whole camera, whatever the View, with scope flags on each card."""
from __future__ import annotations

import config
import datamodel
import db
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job
from tests.test_api_classify import write_two_groups

CAM = "camA"


class ClassifySearchTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._emb = config.EMBEDDING_ENABLED
        config.EMBEDDING_ENABLED = False
        self.blue, self.red = write_two_groups(CAM)
        datamodel.save_rois(CAM, [
            ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"]),
            ROI("seal", 0, 0, 1, 1, products=["A"]),  # applies to product A only
            ROI("edge", 0, 0, 1, 1),  # the whole camera
        ])
        for f in self.blue:
            labels.set_label(CAM, "type", f, "A")
        for f in self.red[:2]:
            labels.set_label(CAM, "type", f, "B")  # red_2 and red_3 have no product yet
        self.base = f"/api/cameras/{CAM}/classify"

    def tearDown(self) -> None:
        config.EMBEDDING_ENABLED = self._emb
        super().tearDown()

    def search(self, text: str, feature: str = "seal", **params) -> dict:
        r = self.client.get(f"{self.base}/grid", params={"feature": feature, "search": text, **params})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def names(self, text: str, feature: str = "seal", **params) -> list[str]:
        return [c["frame"] for c in self.search(text, feature, **params)["items"]]

    def card(self, frame: str, feature: str = "seal") -> dict:
        return next(c for c in self.search(frame, feature)["items"] if c["frame"] == frame)

    # --- what it finds ----------------------------------------------------------------------------------------
    def test_matches_part_of_the_name_ignoring_case_in_name_order(self) -> None:
        self.assertEqual(self.names("blue"), sorted(self.blue))
        self.assertEqual(self.names("RED_1"), ["red_1.png"])
        self.assertEqual(self.names("_2"), ["blue_2.png", "red_2.png"])
        self.assertEqual(self.search("blue")["total"], 4)

    def test_no_match_is_an_empty_page_not_an_error(self) -> None:
        body = self.search("nothing-like-this")
        self.assertEqual((body["total"], body["items"], body["n_pages"], body["page"]), (0, [], 1, 1))

    def test_blank_search_is_the_normal_grid(self) -> None:
        body = self.client.get(f"{self.base}/grid", params={"feature": "seal", "search": "  "}).json()
        self.assertNotIn("search", body)

    def test_it_searches_the_whole_camera_whatever_the_view_and_scope(self) -> None:
        # seal covers product A only, yet the red pictures (product B, or none) are found too
        self.assertEqual(self.names("red"), sorted(self.red))
        self.assertEqual(self.names("red", view="Labeled A"), sorted(self.red))  # the View does not narrow it
        self.assertEqual(self.names("blue", view="Deleted"), sorted(self.blue))

    def test_it_works_before_anything_was_scored(self) -> None:
        body = self.search("blue")
        self.assertFalse(body["has_results"])
        self.assertEqual(body["total"], 4)
        self.assertEqual(body["items"][0]["leanings"], {})
        self.assertIsNone(body["items"][0]["bars"])

    def test_scored_pictures_keep_their_leanings(self) -> None:
        r = self.client.post(f"{self.base}/refresh", json={"feature": "edge"})
        wait_for_job(self.client, r.json()["id"])
        self.assertTrue(self.search("blue", "edge")["has_results"])

    def test_paging(self) -> None:
        body = self.client.get(f"{self.base}/grid", params={"feature": "seal", "search": ".png", "per_page": 12, "page": 2}).json()
        self.assertEqual((body["total"], body["n_pages"], body["page"], len(body["items"])), (8, 1, 1, 8))

    # --- scope and state flags --------------------------------------------------------------------------------
    def test_pictures_outside_the_roi_scope_are_flagged_with_their_product(self) -> None:
        self.assertFalse(self.card("blue_0.png")["outside"])  # product A, which seal covers
        red0 = self.card("red_0.png")
        self.assertTrue(red0["outside"])
        self.assertEqual(red0["product"], "B")
        red3 = self.card("red_3.png")
        self.assertTrue(red3["outside"])
        self.assertIsNone(red3["product"])  # no product yet

    def test_a_whole_camera_feature_and_the_product_roi_have_nothing_outside(self) -> None:
        for feature in ("edge", "type"):
            self.assertFalse(any(c["outside"] for c in self.search("png", feature)["items"]), feature)

    def test_product_label_and_roi_label_are_both_on_the_card(self) -> None:
        labels.set_label(CAM, "seal", "blue_0.png", "OK")
        c = self.card("blue_0.png")
        self.assertEqual((c["label"], c["product"]), ("OK", "A"))

    def test_a_deleted_picture_is_found_and_not_flagged_outside(self) -> None:
        self.client.post(f"{self.base}/delete", json={"feature": "seal", "frame": "blue_1.png"})
        c = self.card("blue_1.png")
        self.assertTrue(c["deleted"])
        self.assertFalse(c["outside"])  # its product label was cleared by the delete: it is flagged as deleted, not as outside
        self.assertIsNone(c["product"])

    def test_changing_the_product_moves_a_picture_into_the_roi_scope(self) -> None:
        self.assertTrue(self.card("red_0.png")["outside"])
        r = self.client.put(f"{self.base}/label", json={"feature": "type", "frame": "red_0.png", "cls": "A"})
        self.assertEqual(r.status_code, 200)
        c = self.card("red_0.png")
        self.assertFalse(c["outside"])
        self.assertEqual(c["product"], "A")

    def test_the_search_answer_names_the_product_roi_and_its_classes(self) -> None:
        s = self.search("blue")["search"]
        self.assertEqual(s, {"query": "blue", "classify_feature": "type", "product_classes": ["A", "B"]})
        datamodel.delete_roi(CAM, "type")
        s = self.search("blue", "edge")["search"]
        self.assertEqual((s["classify_feature"], s["product_classes"]), (None, []))

    def test_normal_grid_cards_are_unchanged(self) -> None:
        r = self.client.post(f"{self.base}/refresh", json={"feature": "edge"})
        wait_for_job(self.client, r.json()["id"])
        body = self.client.get(f"{self.base}/grid", params={"feature": "edge"}).json()
        self.assertNotIn("search", body)
        self.assertEqual(set(body["items"][0]), {"frame", "label", "golden", "deleted", "leanings", "bars", "cluster", "edge", "measure"})

    # --- bringing a muted picture back ------------------------------------------------------------------------
    def mute(self, frame: str, feature: str = "edge") -> None:
        """What the duplicate step does: hide the picture from the ROI's grid."""
        db.add_dedup_mutes(CAM, feature, [(frame, "", 3)])

    def unmute(self, frame: str, feature: str = "edge"):
        return self.client.post(f"{self.base}/unmute", json={"feature": feature, "frame": frame})

    def test_the_search_says_which_pictures_are_muted_for_the_roi(self) -> None:
        self.mute("red_3.png")
        self.assertTrue(self.card("red_3.png", "edge")["muted"])
        self.assertFalse(self.card("red_2.png", "edge")["muted"])
        self.assertFalse(self.card("red_3.png", "seal")["muted"])  # muted per ROI

    def test_unmute_brings_it_back(self) -> None:
        self.mute("red_3.png")
        r = self.unmute("red_3.png")
        self.assertEqual((r.status_code, r.json()["muted"], r.json()["muted_count"]), (200, False, 0))
        self.assertFalse(self.card("red_3.png", "edge")["muted"])
        self.assertEqual(db.muted_frames(CAM, "edge"), set())

    def test_unmute_touches_only_that_picture_and_that_roi(self) -> None:
        self.mute("red_3.png")
        self.mute("red_2.png")
        self.mute("red_3.png", "seal")
        self.unmute("red_3.png")
        self.assertEqual(db.muted_frames(CAM, "edge"), {"red_2.png"})
        self.assertEqual(db.muted_frames(CAM, "seal"), {"red_3.png"})

    def test_unmuting_a_picture_that_is_not_muted_is_harmless(self) -> None:
        r = self.unmute("red_3.png")
        self.assertEqual((r.status_code, r.json()["muted_count"]), (200, 0))

    def test_unmute_rejects_unknown_frames_and_rois(self) -> None:
        self.assertEqual(self.unmute("nope.png").status_code, 404)
        self.assertEqual(self.unmute("red_3.png", "nope").status_code, 404)

    def test_there_is_no_manual_mute(self) -> None:
        """Hiding a picture by hand was removed: Delete is how a picture is got rid of, the duplicate step does the muting."""
        r = self.client.put(f"{self.base}/mute", json={"feature": "edge", "frame": "red_3.png", "muted": True})
        self.assertIn(r.status_code, (404, 405))
        self.assertEqual(db.muted_frames(CAM, "edge"), set())


if __name__ == "__main__":
    import unittest

    unittest.main()
