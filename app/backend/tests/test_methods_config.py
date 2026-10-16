"""The global choice of scoring methods (Configuration page): gating, hiding and the API."""
from __future__ import annotations

from unittest.mock import patch

import numpy as np

import classify
import config
import datamodel
import db
import methods_config
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job
from tests.test_api_classify import CAM, FEAT, write_two_groups


class FakeEmbeddings:
    """Stand-in for PyTorch: two 'backbones' with deterministic vectors; records which were asked for."""

    def __init__(self) -> None:
        self.asked: list[str] = []

    def backbones(self) -> list[str]:
        return ["resnet18", "resnet50"]

    def iter_embed_batches(self, cutouts, backbone, batch_size=None):
        if not cutouts:  # like the real one: nothing to embed, nothing yielded
            return
        self.asked.append(backbone)
        rows = []
        for img in cutouts:
            mean = img.reshape(-1, 3).mean(axis=0).astype(np.float32)
            v = np.concatenate([mean, [1.0, float(len(backbone))]]).astype(np.float32)
            rows.append(v / np.linalg.norm(v))
        yield 0, np.stack(rows)


class MethodsConfigTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._emb = config.EMBEDDING_ENABLED
        self.fake = FakeEmbeddings()
        self.patches = [
            patch("embedding.backbones", self.fake.backbones),
            patch("embedding.iter_embed_batches", self.fake.iter_embed_batches),
        ]
        for p in self.patches:
            p.start()
        self.blue, self.red = write_two_groups(CAM)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        self.base = f"/api/cameras/{CAM}/classify"

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()
        config.EMBEDDING_ENABLED = self._emb
        super().tearDown()

    # helpers
    def put(self, active):
        return self.client.put("/api/config/methods", json={"active": active})

    def seed_goldens(self):
        for frame, cls in ((self.blue[0], "OK"), (self.red[0], "NG")):
            self.client.put(f"{self.base}/label", json={"feature": FEAT, "frame": frame, "cls": cls})
            self.client.put(f"{self.base}/golden", json={"feature": FEAT, "frame": frame, "golden": True})

    def refresh(self):
        r = self.client.post(f"{self.base}/refresh", json={"feature": FEAT})
        self.assertEqual(r.status_code, 202, r.text)
        job = wait_for_job(self.client, r.json()["id"], timeout=60)
        self.assertEqual(job["status"], "done", job)

    def state(self):
        return self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()

    def grid(self):
        return self.client.get(f"{self.base}/grid", params={"feature": FEAT, "order": "Name"}).json()

    def cached_kinds(self) -> set[str]:
        con = db.connect()
        try:
            return {r["kind"] for r in con.execute("SELECT DISTINCT kind FROM score_cache").fetchall()}
        finally:
            con.close()

    # --- the setting ---
    def test_all_installed_methods_are_active_by_default(self) -> None:
        self.assertEqual(methods_config.active(), ["cpu", "resnet18", "resnet50"])
        body = self.client.get("/api/config/methods").json()
        self.assertEqual([m["id"] for m in body["methods"]], ["cpu", "resnet18", "resnet50"])
        self.assertTrue(all(m["active"] and m["installed"] for m in body["methods"]))
        self.assertEqual({m["id"]: m["tag"] for m in body["methods"]}, {"cpu": "CPU", "resnet18": "R18", "resnet50": "R50"})

    def test_choice_is_saved_globally_and_keeps_the_fixed_order(self) -> None:
        r = self.put(["resnet50", "cpu"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(methods_config.active(), ["cpu", "resnet50"])
        self.assertEqual([m["active"] for m in r.json()["methods"]], [True, False, True])
        self.assertEqual(classify.methods_available(), ["cpu", "resnet50"])
        self.assertEqual(methods_config.active_backbones(), ["resnet50"])

    def test_at_least_one_method_and_only_known_names(self) -> None:
        self.assertEqual(self.put([]).status_code, 422)
        self.assertEqual(self.put(["resnet101"]).status_code, 422)
        self.assertEqual(methods_config.active(), ["cpu", "resnet18", "resnet50"])

    def test_a_saved_choice_with_nothing_installed_falls_back_to_everything_installed(self) -> None:
        self.assertEqual(self.put(["resnet50"]).status_code, 200)
        with patch("embedding.backbones", return_value=[]):
            self.assertEqual(methods_config.active(), ["cpu"])
            self.assertEqual(self.put(["resnet50"]).status_code, 422)  # not installed: nothing left to keep on

    # --- scoring ---
    def test_a_method_that_is_off_is_not_computed(self) -> None:
        self.put(["resnet50"])
        self.seed_goldens()
        self.refresh()
        self.assertEqual(set(self.fake.asked), {"resnet50"})
        self.assertEqual(self.cached_kinds(), {"resnet50"})  # no histogram, no grey image, no resnet18
        self.assertEqual(self.state()["methods"], ["resnet50"])
        for item in self.grid()["items"]:
            self.assertLessEqual(set(item["leanings"]), {"resnet50"})
        scored = [i for i in self.grid()["items"] if i["bars"]]
        self.assertTrue(scored)  # the bars stay
        self.assertEqual(scored[0]["leanings"], {"resnet50": scored[0]["leanings"]["resnet50"]})

    def test_switching_a_method_off_hides_it_at_once_and_back_on_restores_it(self) -> None:
        self.seed_goldens()
        self.refresh()
        item = next(i for i in self.grid()["items"] if i["frame"] == self.blue[1])
        self.assertEqual(set(item["leanings"]), {"cpu", "resnet18", "resnet50"})
        self.put(["resnet50"])
        item = next(i for i in self.grid()["items"] if i["frame"] == self.blue[1])
        self.assertEqual(set(item["leanings"]), {"resnet50"})
        self.assertEqual(self.state()["missing_methods"], [])
        self.put(["cpu", "resnet18", "resnet50"])
        item = next(i for i in self.grid()["items"] if i["frame"] == self.blue[1])
        self.assertEqual(set(item["leanings"]), {"cpu", "resnet18", "resnet50"})  # nothing was lost

    def test_a_method_switched_on_after_the_refresh_is_reported_as_missing(self) -> None:
        self.put(["resnet50"])
        self.seed_goldens()
        self.refresh()
        self.assertEqual(self.state()["missing_methods"], [])
        self.put(["cpu", "resnet50"])
        self.assertEqual(self.state()["missing_methods"], ["cpu"])
        self.refresh()
        self.assertEqual(self.state()["missing_methods"], [])

    def test_insights_and_rank_follow_the_active_methods(self) -> None:
        self.put(["resnet18"])
        self.seed_goldens()
        self.refresh()
        st = self.state()
        self.assertEqual((st["methods"], st["default_rank"]), (["resnet18"], "resnet18"))
        ins = self.client.get(f"/api/cameras/{CAM}/insights", params={"feature": FEAT}).json()
        self.assertEqual(ins["methods"], ["resnet18"])

    # --- other users of the embeddings ---
    def test_dedup_outliers_and_similar_only_offer_active_embeddings(self) -> None:
        self.put(["cpu", "resnet50"])
        dedup = self.client.get(f"/api/cameras/{CAM}/dedup/state", params={"feature": FEAT}).json()
        self.assertEqual(dedup["backbones"], ["resnet50"])
        self.assertEqual(dedup["params"]["method"], "resnet50")
        bad = self.client.put(
            f"/api/cameras/{CAM}/dedup/settings",
            json={"feature": FEAT, "method": "resnet18", "epsilon": 0.05, "min_points": 2},
        )
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(
            self.client.post(f"/api/cameras/{CAM}/dedup/outliers", json={"feature": FEAT, "method": "resnet18"}).status_code, 422
        )
        self.assertEqual(
            self.client.post(
                f"/api/cameras/{CAM}/classify/similar", json={"feature": FEAT, "frame": self.blue[0], "method": "resnet18"}
            ).status_code,
            422,
        )

    def test_dedup_says_so_when_no_embedding_is_switched_on(self) -> None:
        self.put(["cpu"])
        dedup = self.client.get(f"/api/cameras/{CAM}/dedup/state", params={"feature": FEAT}).json()
        self.assertEqual(dedup["reason"], "methods_off")
        self.assertEqual(dedup["backbones"], [])
