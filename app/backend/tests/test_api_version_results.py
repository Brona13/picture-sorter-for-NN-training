from __future__ import annotations

import datetime

import datamodel
import labels
import versions
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames


class VersionResultsApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames("camA", 4)
        datamodel.save_rois("camA", [ROI(name="seal", x=0, y=0, w=0.5, h=0.5), ROI(name="cap", x=0.5, y=0.5, w=0.4, h=0.4)])
        self.base = "/api/cameras/camA/versions"
        labels.set_label("camA", "seal", self.frames[0], "OK")
        self.v1 = self.freeze("seal", "first")
        labels.set_label("camA", "seal", self.frames[1], "NG")
        self.v2 = self.freeze("seal", "second")
        self.cap = self.freeze("cap", "cap v1")

    def freeze(self, feature: str, name: str) -> int:
        r = self.client.post(self.base, json={"feature": feature, "name": name, "notes": ""})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def add(self, version_id: int, feature: str = "seal", **over):
        body = {"feature": feature, "name": "accuracy", "value": 0.97, **over}
        return self.client.post(f"{self.base}/{version_id}/results", json=body)

    def listing(self, feature: str = "seal") -> dict:
        return self.client.get(self.base, params={"feature": feature}).json()

    def test_versions_start_without_results(self) -> None:
        body = self.listing()
        self.assertEqual([v["results"] for v in body["versions"]], [[], []])
        self.assertEqual(body["result_names"], [])

    def test_add_and_list_with_defaults_and_cleaning(self) -> None:
        r = self.add(self.v1, name="  NG   recall ", value=0.91, note=" run 3 ", measured="2026-10-14")
        self.assertEqual(r.status_code, 201, r.text)
        out = r.json()
        self.assertEqual((out["name"], out["value"], out["note"], out["measured"], out["version_id"]), ("NG recall", 0.91, "run 3", "2026-10-14", self.v1))
        today = self.add(self.v2).json()
        self.assertEqual(today["measured"], datetime.date.today().isoformat())
        body = self.listing()
        self.assertEqual([len(v["results"]) for v in body["versions"]], [1, 1])
        self.assertEqual(body["result_names"], ["accuracy", "NG recall"])

    def test_results_are_listed_newest_measurement_first(self) -> None:
        self.add(self.v1, value=0.5, measured="2026-10-01")
        self.add(self.v1, value=0.7, measured="2026-10-10")
        self.add(self.v1, value=0.6, measured="2026-10-05")
        v1 = self.listing()["versions"][0]
        self.assertEqual([r["value"] for r in v1["results"]], [0.7, 0.6, 0.5])

    def test_validation(self) -> None:
        for bad in (
            {"name": "   "},
            {"name": "x" * 81},
            {"note": "n" * 501},
            {"measured": "15.10.2026"},
            {"measured": "2026-13-40"},
        ):
            self.assertEqual(self.add(self.v1, **bad).status_code, 422, bad)
        self.assertEqual(self.client.post(f"{self.base}/{self.v1}/results", json={"feature": "seal", "name": "a", "value": "high"}).status_code, 422)
        self.assertEqual(self.listing()["versions"][0]["results"], [])

    def test_a_version_of_another_feature_or_a_missing_one_is_refused(self) -> None:
        self.assertEqual(self.add(self.cap, feature="seal").status_code, 404)  # cap's version, seal's feature
        self.assertEqual(self.add(99999).status_code, 404)
        self.assertEqual(self.add(self.v1, feature="zzz").status_code, 404)

    def test_edit_and_delete(self) -> None:
        rid = self.add(self.v1, value=0.5).json()["id"]
        r = self.client.put(f"{self.base}/{self.v1}/results/{rid}", json={"feature": "seal", "name": "F1", "value": 0.8, "note": "fixed typo", "measured": "2026-10-02"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["name"], r.json()["value"], r.json()["version_id"]), ("F1", 0.8, self.v1))
        self.assertEqual(self.listing()["versions"][0]["results"][0]["note"], "fixed typo")
        self.assertEqual(self.client.delete(f"{self.base}/{self.v1}/results/{rid}", params={"feature": "seal"}).status_code, 200)
        self.assertEqual(self.listing()["versions"][0]["results"], [])
        self.assertEqual(self.client.delete(f"{self.base}/{self.v1}/results/{rid}", params={"feature": "seal"}).status_code, 404)

    def test_a_result_cannot_be_changed_through_the_wrong_version_or_feature(self) -> None:
        rid = self.add(self.v1).json()["id"]
        body = {"feature": "seal", "name": "x", "value": 1}
        self.assertEqual(self.client.put(f"{self.base}/{self.v2}/results/{rid}", json=body).status_code, 404)
        self.assertEqual(self.client.put(f"{self.base}/{self.cap}/results/{rid}", json={**body, "feature": "cap"}).status_code, 404)
        self.assertEqual(self.client.delete(f"{self.base}/{self.v2}/results/{rid}", params={"feature": "seal"}).status_code, 404)
        self.assertEqual(self.listing()["versions"][0]["results"][0]["name"], "accuracy")  # untouched

    def test_results_survive_deleting_and_reverting_a_version(self) -> None:
        self.add(self.v1, value=0.9)
        self.assertEqual(self.client.delete(f"{self.base}/{self.v1}", params={"feature": "seal"}).status_code, 200)  # v1 is not active
        v1 = self.listing()["versions"][0]
        self.assertIsNotNone(v1["deleted"])
        self.assertEqual(v1["results"][0]["value"], 0.9)  # the history of what it achieved stays
        self.assertEqual(self.add(self.v1, value=0.92).status_code, 201)  # and can still be added to

    def test_features_are_kept_apart(self) -> None:
        self.add(self.cap, feature="cap", name="cap accuracy")
        self.assertEqual(self.listing("seal")["result_names"], [])
        self.assertEqual(self.listing("cap")["result_names"], ["cap accuracy"])
        self.assertEqual(versions.results_by_version("camA", "seal"), {})

    def test_numbers_that_are_not_finite_are_refused_in_the_domain_layer(self) -> None:
        for bad in (float("nan"), float("inf"), True, None):
            with self.assertRaises(versions.ResultError):
                versions.add_result("camA", "seal", self.v1, "m", bad)
