from __future__ import annotations

import datamodel
import labels
from roi import ROI
from tests.api_helpers import ApiTestCase, write_frames


class VersionsApiTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames("camA", 4)
        datamodel.save_rois(
            "camA",
            [
                ROI(name="seal", x=0, y=0, w=0.5, h=0.5),
                ROI(name="cap", x=0.5, y=0.5, w=0.4, h=0.4),
            ],
        )
        self.base = "/api/cameras/camA/versions"

    def freeze(self, feature="seal", name="first", notes="n"):
        return self.client.post(
            self.base, json={"feature": feature, "name": name, "notes": notes}
        )

    def test_feature_picker_includes_whole_frame(self) -> None:
        body = self.client.get(self.base + "/features").json()
        names = [f["feature"] for f in body]
        self.assertEqual(names, ["seal", "cap", "whole-frame"])

    def test_empty_history(self) -> None:
        body = self.client.get(self.base, params={"feature": "seal"}).json()
        self.assertEqual(body["versions"], [])
        self.assertEqual(body["classes"], ["OK", "NG"])
        self.assertEqual(body["counts"]["total"], 4)

    def test_unknown_feature_and_camera(self) -> None:
        self.assertEqual(self.client.get(self.base, params={"feature": "zzz"}).status_code, 404)
        self.assertEqual(self.client.get("/api/cameras/nope/versions", params={"feature": "seal"}).status_code, 404)
        self.assertEqual(self.freeze(feature="zzz").status_code, 404)

    def test_freeze_numbers_and_active(self) -> None:
        labels.set_label("camA", "seal", self.frames[0], "OK")
        r1 = self.freeze(name="a")
        self.assertEqual(r1.status_code, 201)
        self.assertEqual(r1.json()["number"], 1)
        labels.set_label("camA", "seal", self.frames[1], "NG")
        r2 = self.freeze(name="b")
        self.assertEqual(r2.json()["number"], 2)
        vs = self.client.get(self.base, params={"feature": "seal"}).json()["versions"]
        self.assertEqual([v["number"] for v in vs], [1, 2])
        self.assertEqual([v["active"] for v in vs], [False, True])
        self.assertEqual(vs[0]["counts"]["OK"], 1)
        self.assertEqual(vs[1]["counts"]["NG"], 1)
        self.assertEqual(vs[0]["stats"], {})  # never scored -> no stats

    def test_revert_restores_labels_and_goldens(self) -> None:
        f = self.frames
        labels.set_label("camA", "seal", f[0], "OK")
        labels.mark_golden("camA", "seal", f[0], "OK")
        v1 = self.freeze(name="a").json()["id"]
        labels.set_label("camA", "seal", f[0], "NG")  # relabel golden -> class follows
        labels.set_label("camA", "seal", f[1], "NG")
        self.freeze(name="b")

        r = self.client.post(f"{self.base}/{v1}/revert", params={"feature": "seal"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(labels.current_labels("camA", "seal"), {f[0]: "OK"})
        self.assertEqual(labels.current_goldens("camA", "seal"), {"OK": [f[0]]})
        vs = self.client.get(self.base, params={"feature": "seal"}).json()["versions"]
        self.assertEqual([v["active"] for v in vs], [True, False])

    def test_revert_rejects_version_of_other_feature(self) -> None:
        labels.set_label("camA", "cap", self.frames[0], "OK")
        other = self.freeze(feature="cap").json()["id"]
        r = self.client.post(f"{self.base}/{other}/revert", params={"feature": "seal"})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(labels.current_labels("camA", "cap"), {self.frames[0]: "OK"})

    def test_delete_keeps_a_greyed_out_row_and_never_reuses_numbers(self) -> None:
        import db

        labels.set_label("camA", "seal", self.frames[0], "OK")
        labels.mark_golden("camA", "seal", self.frames[0], "OK")
        v1 = self.freeze(name="a").json()["id"]
        v2 = self.freeze(name="b").json()["id"]
        v3 = self.freeze(name="c").json()["id"]  # v3 is now active

        self.assertEqual(
            self.client.delete(f"{self.base}/{v3}", params={"feature": "seal"}).status_code, 409
        )  # active
        r = self.client.delete(f"{self.base}/{v2}", params={"feature": "seal"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            self.client.delete(f"{self.base}/{v2}", params={"feature": "seal"}).status_code, 409
        )  # already deleted

        vs = self.client.get(self.base, params={"feature": "seal"}).json()["versions"]
        self.assertEqual([v["number"] for v in vs], [1, 2, 3])  # the gap stays visible
        self.assertEqual([v["deleted"] is not None for v in vs], [False, True, False])
        self.assertEqual(vs[1]["name"], "b")
        con = db.connect()
        try:
            n = con.execute("SELECT COUNT(*) FROM version_items WHERE version_id=?", (v2,)).fetchone()[0]
        finally:
            con.close()
        self.assertEqual(n, 0)  # snapshot gone
        self.assertEqual(labels.current_goldens("camA", "seal"), {"OK": [self.frames[0]]})  # working state untouched

        # A deleted version cannot be reverted to.
        r = self.client.post(f"{self.base}/{v2}/revert", params={"feature": "seal"})
        self.assertEqual(r.status_code, 409)

        # Deleting the newest non-active version must not free its number.
        self.client.delete(f"{self.base}/{v1}", params={"feature": "seal"})
        self.client.post(f"{self.base}/{v3}/revert", params={"feature": "seal"})  # no-op revert keeps v3 active
        v4 = self.freeze(name="d").json()
        self.assertEqual(v4["number"], 4)
        v4_id = v4["id"]
        self.freeze(name="e")  # v5 active, v4 not
        self.client.delete(f"{self.base}/{v4_id}", params={"feature": "seal"})
        self.assertEqual(self.freeze(name="f").json()["number"], 6)

    def test_deleted_versions_are_not_counted_in_summaries(self) -> None:
        labels.set_label("camA", "seal", self.frames[0], "OK")
        a = self.freeze(name="a").json()["id"]
        self.freeze(name="b")
        self.client.delete(f"{self.base}/{a}", params={"feature": "seal"})
        import versions

        self.assertEqual(versions.summaries("camA", ["seal"])["seal"], {"count": 1, "active_number": 2})

    def test_delete_rejects_version_of_other_feature(self) -> None:
        labels.set_label("camA", "cap", self.frames[0], "OK")
        other = self.freeze(feature="cap").json()["id"]
        self.freeze(feature="cap", name="again")
        r = self.client.delete(f"{self.base}/{other}", params={"feature": "seal"})
        self.assertEqual(r.status_code, 404)

    def test_freeze_uses_persisted_scores_for_stats(self) -> None:
        import classify
        import db
        import engine

        results = [
            classify.FrameScore(
                frame=self.frames[0],
                golden=False,
                per_method={"cpu": classify.MethodScore(dists={"OK": 0.2}, leaning="OK", margin=0.1, novelty=0.5)},
            ),
            classify.FrameScore(
                frame=self.frames[1],
                golden=False,
                per_method={"cpu": classify.MethodScore(dists={"OK": 0.4}, leaning="OK", margin=0.1, novelty=0.7)},
            ),
        ]
        key = classify._roi_cache_key(engine.resolve_roi("camA", "seal"))
        db.save_results("camA", "seal", key, "g", "f", classify.serialise_results(results))
        self.freeze()
        v = self.client.get(self.base, params={"feature": "seal"}).json()["versions"][0]
        self.assertAlmostEqual(v["stats"]["cpu"]["mean"], 0.6)
