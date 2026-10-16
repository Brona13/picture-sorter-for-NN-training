from __future__ import annotations

from pathlib import Path

import datamodel
import labels
from tests.api_helpers import ApiTestCase, write_frames

BOX = {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}


class ProjectVersionTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.f = write_frames("camA", 6)
        for name in ("roi1", "roi2"):
            self.client.put("/api/cameras/camA/rois", json={**BOX, "name": name})
        # f0 OK, f1 NG (both ROIs), f2 contradiction, f3 open, f4 decided by the user
        labels.set_label("camA", "roi1", self.f[0], "OK")
        labels.set_label("camA", "roi1", self.f[1], "NG")
        labels.set_label("camA", "roi2", self.f[1], "NG")
        labels.set_label("camA", "roi1", self.f[2], "OK")
        labels.set_label("camA", "roi2", self.f[2], "NG")
        labels.set_label("camA", "roi1", self.f[4], "OK")
        labels.set_label("camA", "roi2", self.f[4], "NG")
        self.client.put("/api/cameras/camA/verdicts/decision", json={"frame": self.f[4], "cls": "NG"})

    def freeze(self, name: str = "first"):
        return self.client.post("/api/cameras/camA/project-versions", json={"name": name, "notes": "n"})

    def test_freeze_counts_and_listing(self) -> None:
        r = self.freeze()
        self.assertEqual(r.status_code, 201)
        c = r.json()["counts"]
        self.assertEqual((c["ok"], c["ng"], c["contradiction"], c["open"], c["total"]), (1, 2, 1, 2, 6))
        body = self.client.get("/api/cameras/camA/project-versions").json()
        self.assertEqual(body["summary"]["ok"], 1)
        v = body["versions"][0]
        self.assertEqual((v["number"], v["name"], v["active"]), (1, "first", True))
        self.assertEqual(self.freeze("second").json()["number"], 2)
        vs = self.client.get("/api/cameras/camA/project-versions").json()["versions"]
        self.assertEqual([x["active"] for x in vs], [False, True])

    def test_export_copies_only_verdict_pictures_into_class_folders(self) -> None:
        vid = self.freeze().json()["id"]
        r = self.client.post(f"/api/cameras/camA/project-versions/{vid}/export")
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual((out["written"], out["missing"], out["hash_mismatch"]), (3, [], []))
        dest = Path(out["destination"])
        self.assertEqual(sorted(p.name for p in (dest / "OK").iterdir()), [self.f[0]])
        self.assertEqual(sorted(p.name for p in (dest / "NG").iterdir()), sorted([self.f[1], self.f[4]]))
        self.assertEqual(dest.parent.name, "project")

    def test_export_is_reproducible_from_the_snapshot_and_leaves_sources_untouched(self) -> None:
        vid = self.freeze().json()["id"]
        before = sorted(p.name for p in datamodel.list_unsorted("camA"))
        d1 = Path(self.client.post(f"/api/cameras/camA/project-versions/{vid}/export").json()["destination"])
        files1 = sorted(str(p.relative_to(d1)) for p in d1.rglob("*.png"))
        labels.clear_label("camA", "roi1", self.f[0])  # the working state moves on
        labels.set_label("camA", "roi1", self.f[3], "OK")
        d2 = Path(self.client.post(f"/api/cameras/camA/project-versions/{vid}/export").json()["destination"])
        self.assertEqual(files1, sorted(str(p.relative_to(d2)) for p in d2.rglob("*.png")))
        self.assertEqual(before, sorted(p.name for p in datamodel.list_unsorted("camA")))

    def test_a_changed_source_frame_is_reported_not_exported(self) -> None:
        vid = self.freeze().json()["id"]
        (datamodel.unsorted_dir("camA") / self.f[0]).unlink()
        out = self.client.post(f"/api/cameras/camA/project-versions/{vid}/export").json()
        self.assertEqual((out["written"], out["missing"]), (2, [self.f[0]]))

    def test_nothing_to_freeze(self) -> None:
        write_frames("camB", 2)
        r = self.client.post("/api/cameras/camB/project-versions", json={"name": "x"})
        self.assertEqual(r.status_code, 422)

    def test_results_delete_and_no_revert(self) -> None:
        v1 = self.freeze().json()["id"]
        v2 = self.freeze("b").json()["id"]
        r = self.client.post(f"/api/cameras/camA/versions/{v2}/results", json={"feature": "@project", "name": "accuracy", "value": 0.9})
        self.assertEqual(r.status_code, 201, r.text)
        listed = self.client.get("/api/cameras/camA/project-versions").json()
        self.assertEqual(listed["versions"][1]["results"][0]["name"], "accuracy")
        self.assertEqual(listed["result_names"], ["accuracy"])
        self.assertEqual(self.client.post(f"/api/cameras/camA/versions/{v1}/revert", params={"feature": "@project"}).status_code, 422)
        self.assertEqual(self.client.delete(f"/api/cameras/camA/versions/{v1}", params={"feature": "@project"}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/cameras/camA/project-versions/{v1}/export").status_code, 409)
        # a ROI version list is not mixed with the project versions
        self.assertEqual(self.client.get("/api/cameras/camA/versions", params={"feature": "roi1"}).json()["versions"], [])

    def test_roi_names_cannot_collide_with_the_reserved_project_name(self) -> None:
        r = self.client.put("/api/cameras/camA/rois", json={**BOX, "name": "@project"})
        self.assertEqual(r.status_code, 422)
