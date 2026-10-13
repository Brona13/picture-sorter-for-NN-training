from __future__ import annotations

import datamodel
import labels
import versions
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames

BOX = {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}


class RoiApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames("camA", 4)
        self.url = "/api/cameras/camA/rois"

    def put(self, **kw):
        return self.client.put(self.url, json={**BOX, **kw})

    def test_empty_camera(self) -> None:
        body = self.client.get(self.url).json()
        self.assertEqual(body["rois"], [])
        self.assertIsNone(body["classify_feature"])
        self.assertEqual(body["inbox_total"], 4)

    def test_add_then_update_quality_roi(self) -> None:
        r = self.put(name="seal")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["feature"], "seal")
        self.assertEqual(r.json()["role"], "quality")
        self.assertEqual(r.json()["classes"], ["OK", "NG"])
        self.put(name="seal", x=0.5, y=0.5, w=0.2, h=0.2)
        rois = self.client.get(self.url).json()["rois"]
        self.assertEqual(len(rois), 1)
        self.assertEqual((rois[0]["x"], rois[0]["w"]), (0.5, 0.2))

    def test_name_and_box_validation(self) -> None:
        self.assertEqual(self.put(name="  ").status_code, 422)
        self.assertEqual(self.put(name="a::b").status_code, 422)
        self.assertEqual(self.put(name="a/b").status_code, 422)
        self.assertEqual(self.put(name="a", x=0.9, w=0.3).status_code, 422)
        self.assertEqual(self.put(name="a", w=0).status_code, 422)
        self.assertEqual(self.put(name="a", x=-0.1).status_code, 422)
        self.assertEqual(self.client.get(self.url).json()["rois"], [])

    def test_classifier_needs_two_products_and_is_unique(self) -> None:
        self.assertEqual(self.put(name="prod", make_classifier=True, product_names=["A"]).status_code, 422)
        ok = self.put(name="prod", make_classifier=True, product_names=["A", " B "])
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["classes"], ["A", "B"])
        body = self.client.get(self.url).json()
        self.assertEqual(body["classify_feature"], "prod")
        self.assertEqual(body["products"], ["A", "B"])
        self.assertEqual(self.put(name="prod2", make_classifier=True, product_names=["X", "Y"]).status_code, 422)

    def test_product_scope_and_sharing(self) -> None:
        self.put(name="prod", make_classifier=True, product_names=["A", "B"])
        self.assertEqual(self.put(name="rod", product="A").json()["feature"], "A::rod")
        self.assertEqual(self.put(name="x", product="Z").status_code, 404)
        shared = self.put(name="seal", shared_with=["A"])
        self.assertEqual(shared.json()["shared_products"], ["A"])
        self.assertEqual(self.put(name="bad", shared_with=["Q"]).status_code, 422)
        self.assertEqual(self.put(name="bad", product="A", shared_with=["B"]).status_code, 422)

        a_scope = self.client.get(self.url, params={"product": "A"}).json()
        self.assertEqual([r["feature"] for r in a_scope["rois"]], ["A::rod"])
        self.assertEqual(a_scope["shared_here"], ["seal"])
        camera_scope = self.client.get(self.url).json()
        self.assertEqual({r["feature"] for r in camera_scope["rois"]}, {"prod", "seal"})
        self.assertEqual(self.client.get(self.url, params={"product": "Z"}).status_code, 404)

    def test_move_keeps_labels_and_goldens(self) -> None:
        self.put(name="seal")
        labels.set_label("camA", "seal", self.frames[0], "OK")
        labels.mark_golden("camA", "seal", self.frames[0], "OK")
        r = self.client.patch(f"{self.url}/seal/geometry", json={"x": 0.4, "y": 0.4, "w": 0.5, "h": 0.5})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["x"], r.json()["goldens"], r.json()["labeled"]), (0.4, 1, 1))
        self.assertEqual(labels.current_goldens("camA", "seal"), {"OK": [self.frames[0]]})
        self.assertEqual(self.client.patch(f"{self.url}/nope/geometry", json=BOX).status_code, 404)
        self.assertEqual(self.client.patch(f"{self.url}/seal/geometry", json={**BOX, "w": 2}).status_code, 422)

    def test_applies_to_products_rules(self) -> None:
        self.put(name="prod", make_classifier=True, product_names=["A", "B"])
        self.put(name="seal")
        self.put(name="rod", product="A")
        ok = self.client.patch(f"{self.url}/seal/products", json={"products": ["A", "B"]})
        self.assertEqual(ok.json()["shared_products"], ["A", "B"])
        cleared = self.client.patch(f"{self.url}/seal/products", json={"products": []})
        self.assertIsNone(cleared.json()["shared_products"])
        self.assertEqual(self.client.patch(f"{self.url}/seal/products", json={"products": ["Q"]}).status_code, 422)
        self.assertEqual(self.client.patch(f"{self.url}/prod/products", json={"products": ["A"]}).status_code, 422)
        self.assertEqual(self.client.patch(f"{self.url}/A::rod/products", json={"products": ["B"]}).status_code, 422)

    def test_delete_purges_everything_for_that_feature_only(self) -> None:
        self.put(name="seal")
        self.put(name="cap")
        f = self.frames
        for feat in ("seal", "cap"):
            labels.set_label("camA", feat, f[0], "OK")
            labels.mark_golden("camA", feat, f[0], "OK")
            versions.freeze("camA", feat, "v", "")
        r = self.client.delete(f"{self.url}/seal")
        self.assertEqual(r.status_code, 200)
        removed = r.json()["removed"]
        self.assertEqual((removed["labels"], removed["goldens"]), (1, 1))
        self.assertIsNone(datamodel.get_roi("camA", "seal"))
        self.assertEqual(labels.current_labels("camA", "seal"), {})
        self.assertEqual(versions.list_versions("camA", "seal"), [])
        self.assertEqual(labels.current_labels("camA", "cap"), {f[0]: "OK"})
        self.assertEqual(len(versions.list_versions("camA", "cap")), 1)
        self.assertEqual(self.client.delete(f"{self.url}/seal").status_code, 404)

    def test_delete_product_scoped_feature_with_separator(self) -> None:
        self.put(name="prod", make_classifier=True, product_names=["A", "B"])
        self.put(name="rod", product="A")
        self.assertEqual(self.client.delete(f"{self.url}/A::rod").status_code, 200)
        self.assertIsNone(datamodel.get_roi("camA", "A::rod"))

    def test_list_reports_counts_and_versions(self) -> None:
        self.put(name="seal")
        labels.set_label("camA", "seal", self.frames[0], "OK")
        labels.set_label("camA", "seal", self.frames[1], "NG")
        versions.freeze("camA", "seal", "first", "")
        row = self.client.get(self.url).json()["rois"][0]
        self.assertEqual((row["labeled"], row["goldens"], row["version_count"], row["active_version"]), (2, 0, 1, 1))
        self.assertEqual((row["frames_seen"], row["inbox_total"]), (4, 4))

    def test_product_names_edit(self) -> None:
        self.assertEqual(self.client.put("/api/cameras/camA/product-names", json={"names": ["A", "B"]}).status_code, 404)
        self.put(name="prod", make_classifier=True, product_names=["A", "B"])
        r = self.client.put("/api/cameras/camA/product-names", json={"names": ["A", "B", "C", "C", " "]})
        self.assertEqual(r.json()["products"], ["A", "B", "C"])
        self.assertEqual(self.client.put("/api/cameras/camA/product-names", json={"names": ["A"]}).status_code, 422)
        self.assertEqual(datamodel.products("camA"), ["A", "B", "C"])  # failed edit left it unchanged

    def test_unclassified_frames_hint(self) -> None:
        self.put(name="prod", make_classifier=True, product_names=["A", "B"])
        labels.set_label("camA", "prod", self.frames[0], "A")
        body = self.client.get(self.url).json()
        self.assertEqual(body["unclassified_frames"], 3)
