from __future__ import annotations

import cv2
import numpy as np

import config
import datamodel
import db
import ingest
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, wait_for_job

CAM = "camA"
FEAT = "seal"


def write_two_groups(camera: str) -> tuple[list[str], list[str]]:
    """4 blue-ish and 4 red-ish frames (distinct pixels so none are duplicates)."""
    datamodel.ensure_camera_dirs(camera)
    blue, red = [], []
    for i in range(4):
        for group, store, color in (("blue", blue, (200, 40, 20)), ("red", red, (20, 40, 200))):
            img = np.full((40, 60, 3), color, dtype=np.uint8)
            img[: 4 + i, : 6 + i] = (255 - i * 9, 255, 255 - i * 17)  # unique corner
            name = f"{group}_{i}.png"
            cv2.imwrite(str(datamodel.unsorted_dir(camera) / name), img)
            store.append(name)
    ingest.rebuild_index(camera)
    return blue, red


class ClassifyApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._emb = config.EMBEDDING_ENABLED
        config.EMBEDDING_ENABLED = False  # classical scoring only: fast and deterministic
        self.blue, self.red = write_two_groups(CAM)
        datamodel.save_rois(CAM, [ROI(name=FEAT, x=0, y=0, w=1, h=1)])
        self.base = f"/api/cameras/{CAM}/classify"

    def tearDown(self) -> None:
        config.EMBEDDING_ENABLED = self._emb
        super().tearDown()

    # helpers
    def label(self, frame, cls):
        return self.client.put(f"{self.base}/label", json={"feature": FEAT, "frame": frame, "cls": cls})

    def golden(self, frame, on):
        return self.client.put(f"{self.base}/golden", json={"feature": FEAT, "frame": frame, "golden": on})

    def grid(self, **params):
        return self.client.get(f"{self.base}/grid", params={"feature": FEAT, **params}).json()

    def state(self):
        return self.client.get(f"{self.base}/state", params={"feature": FEAT}).json()

    def refresh(self):
        r = self.client.post(f"{self.base}/refresh", json={"feature": FEAT})
        self.assertEqual(r.status_code, 202, r.text)
        job = wait_for_job(self.client, r.json()["id"], timeout=60)
        self.assertEqual(job["status"], "done", job)
        return job

    def seed_goldens(self):
        self.label(self.blue[0], "OK")
        self.golden(self.blue[0], True)
        self.label(self.red[0], "NG")
        self.golden(self.red[0], True)

    # --- tests ---
    def test_state_before_any_scoring(self) -> None:
        st = self.state()
        self.assertEqual(st["classes"], ["OK", "NG"])
        self.assertEqual(st["methods"], ["cpu"])
        self.assertFalse(st["has_results"])
        self.assertTrue(st["cold_start"])
        self.assertEqual(st["counts"]["total"], 8)
        self.assertEqual(st["settings"]["per_page"], 24)
        g = self.grid()
        self.assertFalse(g["has_results"])
        self.assertEqual(g["items"], [])

    def test_unknown_inputs(self) -> None:
        self.assertEqual(self.client.get(f"{self.base}/state", params={"feature": "zzz"}).status_code, 404)
        self.assertEqual(self.client.get(f"{self.base}/grid", params={"feature": FEAT, "view": "Bogus"}).status_code, 422)
        self.assertEqual(self.client.get(f"{self.base}/grid", params={"feature": FEAT, "rank": "nope"}).status_code, 422)
        self.assertEqual(self.client.get(f"{self.base}/grid", params={"feature": FEAT, "order": "x"}).status_code, 422)
        self.assertEqual(self.client.get(f"{self.base}/grid", params={"feature": FEAT, "per_page": 13}).status_code, 422)
        self.assertEqual(self.label("nope.png", "OK").status_code, 404)
        self.assertEqual(self.label(self.blue[0], "MAYBE").status_code, 422)

    def test_label_and_golden_invariants(self) -> None:
        f = self.blue[0]
        self.assertEqual(self.golden(f, True).status_code, 409)  # unlabeled frame cannot be golden
        self.assertIsNone(labels.current_golden_for_frame(CAM, FEAT, f))

        r = self.label(f, "OK").json()
        self.assertEqual((r["card"]["label"], r["card"]["golden"]), ("OK", None))
        self.assertEqual(r["counts"]["OK"], 1)

        r = self.golden(f, True).json()
        self.assertEqual(r["card"]["golden"], "OK")
        self.assertEqual(r["counts"]["golden_OK"], 1)

        # relabeling a golden changes its reference class
        r = self.label(f, "NG").json()
        self.assertEqual((r["card"]["label"], r["card"]["golden"]), ("NG", "NG"))
        self.assertEqual((r["counts"]["golden_OK"], r["counts"]["golden_NG"]), (0, 1))

        # un-starring keeps the label
        r = self.golden(f, False).json()
        self.assertEqual((r["card"]["label"], r["card"]["golden"]), ("NG", None))

        # clearing the label of a golden drops the golden too
        self.golden(f, True)
        r = self.label(f, None).json()
        self.assertEqual((r["card"]["label"], r["card"]["golden"]), (None, None))
        self.assertEqual(r["counts"]["golden_NG"], 0)

    def test_refresh_scores_and_leanings(self) -> None:
        self.seed_goldens()
        self.assertFalse(self.state()["cold_start"])
        job = self.refresh()
        self.assertEqual(job["result"], {"frames": 8, "scored": True})
        self.assertEqual(job["progress"]["phase"], "persistence")

        st = self.state()
        self.assertTrue(st["has_results"] and st["scored"])
        self.assertEqual(st["stale"], {"goldens": False, "frames": False})

        g = self.grid(rank="cpu", order="Name")
        self.assertEqual(g["total"], 8)
        by = {i["frame"]: i for i in g["items"]}
        self.assertEqual(by[self.blue[1]]["leanings"]["cpu"], "OK")
        self.assertEqual(by[self.red[2]]["leanings"]["cpu"], "NG")
        self.assertIsNone(by[self.blue[0]]["bars"])  # goldens are references, not scored
        self.assertEqual(by[self.blue[0]]["golden"], "OK")
        bars = by[self.blue[1]]["bars"]
        self.assertEqual([r["cls"] for r in bars["rows"]], ["OK", "NG"])
        self.assertTrue(bars["rows"][0]["leader"])
        self.assertEqual(bars["rows"][0]["rel"], 1.0)

    def test_staleness_signals(self) -> None:
        self.seed_goldens()
        self.refresh()
        self.label(self.blue[1], "OK")
        self.golden(self.blue[1], True)
        self.assertEqual(self.state()["stale"], {"goldens": True, "frames": False})
        self.refresh()
        self.assertEqual(self.state()["stale"], {"goldens": False, "frames": False})
        img = np.full((40, 60, 3), 99, dtype=np.uint8)
        cv2.imwrite(str(datamodel.unsorted_dir(CAM) / "new.png"), img)
        ingest.rebuild_index(CAM)
        datamodel.invalidate_frames(CAM)
        self.assertEqual(self.state()["stale"], {"goldens": False, "frames": True})

    def test_views_and_pagination(self) -> None:
        self.seed_goldens()
        self.label(self.blue[1], "OK")
        self.refresh()
        names = lambda **p: sorted(i["frame"] for i in self.grid(order="Name", per_page=96, **p)["items"])  # noqa: E731
        self.assertEqual(len(names()), 8)
        self.assertEqual(names(view="Golden"), sorted([self.blue[0], self.red[0]]))
        self.assertEqual(names(view="Labeled OK"), sorted([self.blue[0], self.blue[1]]))
        self.assertEqual(len(names(view="Unlabeled")), 5)

        g = self.grid(per_page=12)
        self.assertEqual((g["page"], g["n_pages"], g["per_page"]), (1, 1, 12))
        # page numbers are clamped
        self.assertEqual(self.grid(page=99)["page"], 1)

    def test_grid_settings_persist(self) -> None:
        r = self.client.put(f"{self.base}/grid-settings", json={"feature": FEAT, "per_page": 48, "cols": 6})
        self.assertEqual(r.status_code, 200)
        st = self.state()["settings"]
        self.assertEqual((st["per_page"], st["cols"]), (48, 6))
        self.assertEqual(self.grid()["per_page"], 48)
        bad = self.client.put(f"{self.base}/grid-settings", json={"feature": FEAT, "per_page": 7, "cols": 6})
        self.assertEqual(bad.status_code, 422)

    def test_soft_delete_cascades_and_restores_clean(self) -> None:
        self.seed_goldens()
        self.refresh()
        f = self.blue[0]
        r = self.client.post(f"{self.base}/delete", json={"feature": FEAT, "frame": f}).json()
        self.assertEqual(r["card"], {"frame": f, "label": None, "golden": None, "deleted": True})
        self.assertEqual(r["counts"]["golden_OK"], 0)
        self.assertNotIn(f, [i["frame"] for i in self.grid(per_page=96)["items"]])
        self.assertEqual([i["frame"] for i in self.grid(view="Deleted")["items"]], [f])
        self.assertTrue((datamodel.unsorted_dir(CAM) / f).exists())  # source frame untouched

        r = self.client.post(f"{self.base}/restore", json={"feature": FEAT, "frame": f}).json()
        self.assertEqual(r["card"], {"frame": f, "label": None, "golden": None, "deleted": False})
        self.assertIn(f, [i["frame"] for i in self.grid(per_page=96)["items"]])

    def test_muted_frames_hidden_unless_requested(self) -> None:
        self.seed_goldens()
        self.refresh()
        m = self.blue[3]
        db.add_dedup_mutes(CAM, FEAT, [(m, labels.frame_hash(CAM, m), 1)])
        self.assertEqual(self.state()["muted_count"], 1)
        self.assertNotIn(m, [i["frame"] for i in self.grid(per_page=96)["items"]])
        self.assertIn(m, [i["frame"] for i in self.grid(per_page=96, show_muted=True)["items"]])

    def test_bulk_label_leaning_never_touches_goldens(self) -> None:
        self.seed_goldens()
        self.refresh()
        q = {"feature": FEAT, "rank": "cpu"}
        pre = self.client.get(f"{self.base}/bulk", params={**q, "mode": "leaning", "lean_cls": "OK"}).json()
        self.assertEqual(pre["selectable"], 6)  # goldens are unscored, hence not selectable
        self.assertGreater(pre["selected"], 0)
        r = self.client.post(
            f"{self.base}/bulk",
            json={"query": q, "mode": "leaning", "lean_cls": "OK", "label_as": "OK"},
        ).json()
        self.assertEqual(r["labeled"], pre["selected"])
        lab = labels.current_labels(CAM, FEAT)
        self.assertEqual(lab[self.red[0]], "NG")  # golden label untouched
        self.assertEqual(labels.current_goldens(CAM, FEAT), {"OK": [self.blue[0]], "NG": [self.red[0]]})
        bad = self.client.post(f"{self.base}/bulk", json={"query": q, "mode": "leaning", "lean_cls": "OK", "label_as": "??"})
        self.assertEqual(bad.status_code, 422)
        bad = self.client.post(f"{self.base}/bulk", json={"query": q, "mode": "wat", "label_as": "OK"})
        self.assertEqual(bad.status_code, 422)

    def test_bulk_clear_applies_to_the_filtered_view_and_spares_goldens(self) -> None:
        self.seed_goldens()  # blue0 golden OK, red0 golden NG
        for f in (self.blue[1], self.blue[2]):
            self.label(f, "OK")
        self.label(self.red[1], "NG")
        self.refresh()
        q = {"feature": FEAT, "rank": "cpu", "view": "Labeled OK"}

        pre = self.client.get(f"{self.base}/clear", params=q).json()
        self.assertEqual(pre, {"matching": 3, "labeled": 2, "goldens": 1})

        r = self.client.post(f"{self.base}/clear", json={"query": q}).json()
        self.assertEqual((r["cleared"], r["goldens_spared"]), (2, 1))
        lab = labels.current_labels(CAM, FEAT)
        self.assertNotIn(self.blue[1], lab)
        self.assertNotIn(self.blue[2], lab)
        self.assertEqual(lab[self.blue[0]], "OK")  # golden kept its label
        self.assertEqual(lab[self.red[1]], "NG")  # outside the filtered view: untouched
        self.assertEqual(labels.current_goldens(CAM, FEAT), {"OK": [self.blue[0]], "NG": [self.red[0]]})
        self.assertEqual(r["counts"]["OK"], 1)

    def test_bulk_clear_with_goldens_removes_the_mark_with_the_label(self) -> None:
        self.seed_goldens()
        self.label(self.red[1], "NG")
        self.refresh()
        q = {"feature": FEAT, "rank": "cpu", "view": "Labeled NG"}

        r = self.client.post(f"{self.base}/clear", json={"query": q, "include_goldens": True}).json()
        self.assertEqual((r["cleared"], r["goldens_spared"]), (2, 0))
        lab = labels.current_labels(CAM, FEAT)
        gold = labels.current_goldens(CAM, FEAT)
        for f in (self.red[0], self.red[1]):
            self.assertNotIn(f, lab)
            self.assertIsNone(labels.golden_class_of(gold, f))  # an unlabeled frame cannot be golden
        self.assertEqual(lab[self.blue[0]], "OK")
        self.assertEqual(labels.golden_class_of(gold, self.blue[0]), "OK")
        for f in self.blue + self.red:  # source frames are never touched
            self.assertTrue((datamodel.unsorted_dir(CAM) / f).exists())

    def test_bulk_clear_nothing_to_clear_and_bad_view(self) -> None:
        self.seed_goldens()
        self.refresh()
        q = {"feature": FEAT, "rank": "cpu", "view": "Unlabeled"}
        r = self.client.post(f"{self.base}/clear", json={"query": q, "include_goldens": True}).json()
        self.assertEqual((r["cleared"], r["goldens_spared"]), (0, 0))
        self.assertEqual(len(labels.current_labels(CAM, FEAT)), 2)
        bad = self.client.post(f"{self.base}/clear", json={"query": {**q, "view": "Bogus"}})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(
            self.client.get(f"{self.base}/clear", params={"feature": "zzz"}).status_code, 404
        )

    def test_auto_assign_preview_then_apply(self) -> None:
        self.seed_goldens()
        self.refresh()
        q = {"feature": FEAT, "rank": "cpu"}
        pre = self.client.get(f"{self.base}/auto", params=q).json()
        self.assertEqual(pre["candidates"], 6)
        self.assertEqual(pre["total"], 6)
        self.assertEqual({p["cls"] for p in pre["per_class"]}, {"OK", "NG"})
        self.assertEqual(labels.current_labels(CAM, FEAT), {self.blue[0]: "OK", self.red[0]: "NG"})  # preview writes nothing

        # only the NG class
        only = self.client.get(f"{self.base}/auto", params={**q, "classes": ["NG"]}).json()
        self.assertEqual([p["cls"] for p in only["per_class"]], ["NG"])

        # grid filter shows exactly the preview frames
        g = self.client.get(f"{self.base}/grid", params={**q, "auto_preview": True, "per_page": 96}).json()
        self.assertEqual(g["total"], 6)

        r = self.client.post(f"{self.base}/auto", json={"query": q}).json()
        self.assertEqual(r["labeled"], 6)
        lab = labels.current_labels(CAM, FEAT)
        self.assertTrue(all(lab[b] == "OK" for b in self.blue))
        self.assertTrue(all(lab[x] == "NG" for x in self.red))
        self.assertEqual(self.client.get(f"{self.base}/auto", params=q).json()["candidates"], 0)

    def test_auto_requires_scores(self) -> None:
        q = {"feature": FEAT}
        pre = self.client.get(f"{self.base}/auto", params=q).json()
        self.assertEqual(pre["total"], 0)
        self.assertEqual(self.client.post(f"{self.base}/auto", json={"query": q}).status_code, 409)
