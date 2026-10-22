"""Renaming a product keeps its labels, goldens, versions and every ROI that depends on it."""
from __future__ import annotations

import json

import config
import datamodel
import db
import labels
import versions
from roi import ROI
from tests.api_helpers import ApiTestCase
from tests.test_api_classify import write_two_groups

CAM, OTHER = "camA", "camB"


def fill(camera: str):
    blue, red = write_two_groups(camera)  # blue_0..3, red_0..3
    datamodel.save_rois(camera, [
        ROI("type", 0, 0, 1, 1, role="classify", classes=["A", "B"]),
        ROI("A::rod", 0, 0, 1, 1),
        ROI("B::rod", 0, 0, 1, 1),
        ROI("seal", 0, 0, 1, 1, products=["A", "B"]),
        ROI("edge", 0, 0, 1, 1),
    ])
    for f in blue:
        labels.set_label(camera, "type", f, "A")
    for f in red[:2]:
        labels.set_label(camera, "type", f, "B")
    labels.mark_golden(camera, "type", blue[0], "A")
    labels.set_label(camera, "A::rod", blue[0], "OK")
    labels.set_label(camera, "A::rod", blue[1], "NG")
    labels.mark_golden(camera, "A::rod", blue[0], "OK")
    labels.set_label(camera, "B::rod", red[0], "OK")
    labels.set_label(camera, "seal", blue[2], "NG")
    versions.freeze(camera, "type", "first")
    versions.freeze(camera, "A::rod", "rod v1")
    db.set_setting(camera, "vision.A::rod", '{"filter": "none"}')
    db.set_setting(camera, "grid.cols.A::rod", "6")
    db.set_setting(camera, "rules.edge_angle.results.A::rod", "{}")
    db.set_setting(camera, "vision.B::rod", '{"filter": "blur"}')
    db.set_setting(camera, "chain.canvas", json.dumps({"nodes": {"roi:A::rod": {"x": 1, "y": 2, "label": "My rod"}, "classify:A::rod": {"x": 3, "y": 4}, "ingest": {"x": 0, "y": 0}}, "viewport": None}))
    db.add_dedup_mutes(camera, "A::rod", [(blue[3], "", 1)])
    db.save_results(camera, "A::rod", "k", "g", "f", b"payload")
    con = db.connect()
    try:
        con.execute("INSERT OR IGNORE INTO score_cache(hash,feature,roi_key,kind,vec,ts) VALUES (?,?,?,?,?,?)", ("h1", "A::rod", "k", "cpu", b"\x00", 0.0))
        con.commit()
    finally:
        con.close()
    return blue, red


def rows_under(camera: str, feature: str) -> dict[str, int]:
    con = db.connect()
    try:
        out = {}
        for table in ("labels", "goldens", "dedup_mute", "versions", "results_cache", "scatter_cache", "cluster_snapshot", "detections"):
            n = con.execute(f"SELECT COUNT(*) FROM {table} WHERE camera=? AND feature=?", (camera, feature)).fetchone()[0]
            if n:
                out[table] = n
        return out
    finally:
        con.close()


class ProductRenameTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._emb = config.EMBEDDING_ENABLED
        config.EMBEDDING_ENABLED = False
        self.blue, self.red = fill(CAM)
        self.base = f"/api/cameras/{CAM}"

    def tearDown(self) -> None:
        config.EMBEDDING_ENABLED = self._emb
        super().tearDown()

    def rename(self, renames: dict[str, str], names: list[str] | None = None):
        names = names if names is not None else [renames.get(p, p) for p in datamodel.products(CAM)]
        return self.client.put(f"{self.base}/product-names", json={"names": names, "renames": renames})

    # --- what follows the rename -------------------------------------------------------------------------------
    def test_the_product_list_changes_and_the_labels_keep_their_pictures(self) -> None:
        r = self.rename({"A": "Alpha"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["products"], ["Alpha", "B"])
        lab = labels.current_labels(CAM, "type")
        self.assertEqual({lab[f] for f in self.blue}, {"Alpha"})
        self.assertEqual({lab[f] for f in self.red[:2]}, {"B"})
        self.assertEqual(labels.current_goldens(CAM, "type"), {"Alpha": [self.blue[0]]})
        counts = labels.counts(CAM, "type")
        self.assertEqual((counts["Alpha"], counts["B"], counts["golden_Alpha"]), (4, 2, 1))
        self.assertNotIn("A", counts)

    def test_the_products_own_rois_keep_their_connection_labels_and_goldens(self) -> None:
        self.rename({"A": "Alpha"})
        self.assertIsNotNone(datamodel.get_roi(CAM, "Alpha::rod"))
        self.assertIsNone(datamodel.get_roi(CAM, "A::rod"))
        self.assertEqual(sorted(datamodel.frames_for_feature(CAM, "Alpha::rod")), sorted(self.blue))  # still its product's pictures
        self.assertEqual(labels.current_labels(CAM, "Alpha::rod"), {self.blue[0]: "OK", self.blue[1]: "NG"})
        self.assertEqual(labels.current_goldens(CAM, "Alpha::rod"), {"OK": [self.blue[0]]})
        self.assertEqual(labels.current_labels(CAM, "A::rod"), {})
        self.assertEqual(rows_under(CAM, "A::rod"), {})
        self.assertEqual(datamodel.list_features_for(CAM, "Alpha"), ["Alpha::rod", "seal"])

    def test_shared_rois_keep_listing_the_product_under_its_new_name(self) -> None:
        self.rename({"A": "Alpha"})
        self.assertEqual(datamodel.get_roi(CAM, "seal").products, ["Alpha", "B"])
        self.assertEqual(sorted(datamodel.frames_for_feature(CAM, "seal")), sorted([*self.blue, *self.red[:2]]))

    def test_the_other_products_and_whole_camera_rois_are_untouched(self) -> None:
        self.rename({"A": "Alpha"})
        self.assertEqual(labels.current_labels(CAM, "B::rod"), {self.red[0]: "OK"})
        self.assertEqual(rows_under(CAM, "B::rod").get("labels"), 1)
        self.assertEqual(db.get_setting(CAM, "vision.B::rod"), '{"filter": "blur"}')
        self.assertIsNotNone(datamodel.get_roi(CAM, "edge"))

    def test_versions_follow(self) -> None:
        self.rename({"A": "Alpha"})
        v = versions.list_versions(CAM, "type")[0]
        self.assertEqual(v["counts"]["Alpha"], 4)
        self.assertEqual(v["counts"]["golden_Alpha"], 1)
        self.assertNotIn("A", v["counts"])
        con = db.connect()
        try:
            classes = {r[0] for r in con.execute("SELECT class FROM version_items WHERE version_id=?", (v["id"],))}
        finally:
            con.close()
        self.assertEqual(classes, {"Alpha", "B"})
        self.assertEqual(len(versions.list_versions(CAM, "Alpha::rod")), 1)
        self.assertEqual(versions.list_versions(CAM, "A::rod"), [])

    def test_settings_scores_and_mutes_follow(self) -> None:
        self.rename({"A": "Alpha"})
        self.assertEqual(db.get_setting(CAM, "vision.Alpha::rod"), '{"filter": "none"}')
        self.assertEqual(db.get_setting(CAM, "grid.cols.Alpha::rod"), "6")
        self.assertEqual(db.get_setting(CAM, "rules.edge_angle.results.Alpha::rod"), "{}")
        for old in ("vision.A::rod", "grid.cols.A::rod", "rules.edge_angle.results.A::rod"):
            self.assertIsNone(db.get_setting(CAM, old))
        self.assertEqual(db.muted_frames(CAM, "Alpha::rod"), {self.blue[3]})
        self.assertEqual(db.muted_frames(CAM, "A::rod"), set())
        self.assertIsNotNone(db.load_results(CAM, "Alpha::rod", "k"))
        con = db.connect()
        try:
            cached = {r[0] for r in con.execute("SELECT feature FROM score_cache WHERE hash='h1'")}
        finally:
            con.close()
        self.assertIn("Alpha::rod", cached)  # the vectors are not computed again

    def test_the_chain_layout_and_arrows_follow(self) -> None:
        self.rename({"A": "Alpha"})
        canvas = self.client.get(f"{self.base}/chain").json()
        ids = {n["id"]: n for n in canvas["nodes"]}
        self.assertIn("roi:Alpha::rod", ids)
        self.assertNotIn("roi:A::rod", ids)
        self.assertEqual((ids["roi:Alpha::rod"]["x"], ids["roi:Alpha::rod"]["y"], ids["roi:Alpha::rod"]["label"]), (1, 2, "My rod"))  # position and name kept
        self.assertNotIn("classify:Alpha::rod", ids)  # the Classify box is part of the Classifier now
        edges = {(e["source"], e["source_handle"], e["target"]) for e in canvas["edges"]}
        self.assertIn(("roi:type", "p:Alpha", "roi:Alpha::rod"), edges)
        self.assertIn(("roi:type", "all", "roi:seal"), edges)  # seal covers every product: one line from the all dot

    def test_a_dedup_source_and_an_evaluation_pick_follow(self) -> None:
        import dedup_box
        import flow

        box = flow.create_node(CAM, "dedup")
        flow.update_node(CAM, box, {"source": {"feature": "type", "dot": "A"}})
        other = flow.create_node(CAM, "dedup")
        flow.update_node(CAM, other, {"source": {"feature": "A::rod", "dot": "OK"}})
        ev = flow.create_node(CAM, "evaluation")
        flow.set_feature_evaluation(CAM, "A::rod", ev)
        dedup_box.set_input(CAM, "A::rod", box)
        self.assertEqual(self.rename({"A": "Alpha"}).status_code, 200)
        self.assertEqual(dedup_box.source_of(CAM, box), {"feature": "type", "dot": "Alpha"})
        self.assertEqual(dedup_box.source_of(CAM, other), {"feature": "Alpha::rod", "dot": "OK"})
        self.assertEqual(flow.feature_evaluation(CAM, "Alpha::rod"), ev)
        self.assertEqual(dedup_box.input_of(CAM, "Alpha::rod"), box)

    def test_several_products_at_once(self) -> None:
        r = self.rename({"A": "Alpha", "B": "Beta"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(datamodel.products(CAM), ["Alpha", "Beta"])
        self.assertEqual(labels.current_labels(CAM, "Beta::rod"), {self.red[0]: "OK"})
        self.assertEqual(datamodel.get_roi(CAM, "seal").products, ["Alpha", "Beta"])

    def test_renaming_while_adding_and_keeping_the_order(self) -> None:
        r = self.client.put(f"{self.base}/product-names", json={"names": ["C", "Alpha", "B"], "renames": {"A": "Alpha"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(datamodel.products(CAM), ["C", "Alpha", "B"])
        self.assertEqual(labels.counts(CAM, "type")["Alpha"], 4)

    def test_a_swap_is_done_in_two_steps(self) -> None:
        self.assertEqual(self.rename({"B": "C"}).status_code, 200)
        self.assertEqual(self.rename({"A": "B"}).status_code, 200)
        self.assertEqual(datamodel.products(CAM), ["B", "C"])
        self.assertEqual(labels.counts(CAM, "type")["B"], 4)  # the former A
        self.assertEqual(labels.counts(CAM, "type")["C"], 2)  # the former B

    def test_other_cameras_are_untouched(self) -> None:
        fill(OTHER)
        self.rename({"A": "Alpha"})
        self.assertEqual(datamodel.products(OTHER), ["A", "B"])
        self.assertIsNotNone(datamodel.get_roi(OTHER, "A::rod"))
        self.assertEqual(db.get_setting(OTHER, "vision.A::rod"), '{"filter": "none"}')
        self.assertEqual(labels.counts(OTHER, "type")["A"], 4)

    def test_nothing_changes_when_the_name_does_not(self) -> None:
        self.assertEqual(self.rename({"A": "A"}).status_code, 200)
        self.assertEqual(datamodel.products(CAM), ["A", "B"])

    # --- what is refused, and then nothing at all changes -----------------------------------------------------------
    def assertUntouched(self) -> None:
        self.assertEqual(datamodel.products(CAM), ["A", "B"])
        self.assertEqual(labels.counts(CAM, "type")["A"], 4)
        self.assertIsNotNone(datamodel.get_roi(CAM, "A::rod"))
        self.assertEqual(datamodel.get_roi(CAM, "seal").products, ["A", "B"])

    def test_refused_renames_change_nothing(self) -> None:
        bad = [
            ({"A": "B"}, None),  # a product of that name exists
            ({"A": "b"}, None),  # the same, ignoring case
            ({"A": ""}, ["", "B"]),  # no name
            ({"A": "A::x"}, ["A::x", "B"]),  # the reserved separator
            ({"A": "a/b"}, ["a/b", "B"]),
            ({"A": "@x"}, ["@x", "B"]),
            ({"Z": "Y"}, ["A", "B"]),  # not a product
            ({"A": "C", "B": "c"}, ["C", "c"]),  # two products, one name
        ]
        for renames, names in bad:
            r = self.rename(renames, names)
            self.assertEqual(r.status_code, 422, (renames, r.text))
            self.assertUntouched()

    def test_the_renamed_product_must_be_in_the_final_list(self) -> None:
        r = self.rename({"A": "Alpha"}, ["A", "B"])
        self.assertEqual(r.status_code, 422, r.text)
        self.assertUntouched()

    def test_a_list_with_fewer_than_two_products_is_refused_before_anything_moves(self) -> None:
        r = self.rename({"A": "Alpha"}, ["Alpha"])
        self.assertEqual(r.status_code, 422, r.text)
        self.assertUntouched()

    def test_a_camera_without_a_product_roi_cannot_rename(self) -> None:
        datamodel.delete_roi(CAM, "type")
        self.assertEqual(self.client.put(f"{self.base}/product-names", json={"names": ["x", "y"], "renames": {"A": "x"}}).status_code, 404)

    def test_data_already_under_the_new_name_stops_the_rename_and_rolls_everything_back(self) -> None:
        labels.set_label(CAM, "Alpha::rod", self.blue[0], "NG")  # a stale label under the name we are renaming to (no ROI)
        r = self.rename({"A": "Alpha"})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertUntouched()
        self.assertEqual(labels.current_labels(CAM, "A::rod"), {self.blue[0]: "OK", self.blue[1]: "NG"})
        self.assertEqual(db.get_setting(CAM, "vision.A::rod"), '{"filter": "none"}')
        self.assertEqual(labels.counts(CAM, "type")["B"], 2)

    def test_renames_default_to_none_so_the_old_call_still_works(self) -> None:
        r = self.client.put(f"{self.base}/product-names", json={"names": ["A", "B", "C"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(datamodel.products(CAM), ["A", "B", "C"])


if __name__ == "__main__":
    import unittest

    unittest.main()
