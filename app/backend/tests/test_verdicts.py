from __future__ import annotations

import db
import labels
from tests.api_helpers import ApiTestCase, write_frames

BOX = {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}


class VerdictTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.frames = write_frames("camA", 6)
        for name in ("roi1", "roi2"):
            self.client.put("/api/cameras/camA/rois", json={**BOX, "name": name})

    def label(self, feature: str, frame: str, cls: str, **kw) -> None:
        labels.set_label("camA", feature, frame, cls, **kw)

    def item(self, frame: str) -> dict:
        body = self.client.get("/api/cameras/camA/verdicts?per_page=100").json()
        return next(i for i in body["items"] if i["frame"] == frame)

    def summary(self) -> dict:
        return self.client.get("/api/cameras/camA/verdicts/summary").json()

    def test_rule_open_single_agree_contradiction(self) -> None:
        f = self.frames
        self.label("roi1", f[0], "OK")  # one source: verdict
        self.label("roi1", f[1], "NG")
        self.label("roi2", f[1], "NG")  # both NG
        self.label("roi1", f[2], "OK")
        self.label("roi2", f[2], "NG")  # mix
        self.assertEqual((self.item(f[0])["status"], self.item(f[0])["kind"]), ("ok", "auto"))
        self.assertEqual(self.item(f[1])["verdict"], "NG")
        self.assertEqual(self.item(f[2])["status"], "contradiction")
        self.assertEqual(self.item(f[3])["status"], "open")
        s = self.summary()
        self.assertEqual((s["ok"], s["ng"], s["contradiction"], s["open"], s["stale"]), (1, 1, 1, 3, 0))
        self.assertEqual(s["total"], 6)

    def test_agreeing_new_roi_keeps_verdict_and_disagreeing_one_makes_contradiction(self) -> None:
        f = self.frames[0]
        self.label("roi1", f, "OK")
        self.assertEqual(self.item(f)["verdict"], "OK")
        self.label("roi2", f, "OK")
        self.assertEqual(self.item(f)["verdict"], "OK")
        self.label("roi2", f, "NG")
        self.assertEqual(self.item(f)["status"], "contradiction")

    def test_inputs_carry_origin_and_page(self) -> None:
        f = self.frames
        self.label("roi1", f[0], "OK")
        labels.set_labels_bulk("camA", "roi2", [f[0]], "OK", via="Dedup")
        ins = {i["short_name"]: i for i in self.item(f[0])["inputs"]}
        self.assertEqual((ins["roi1"]["source"], ins["roi1"]["via"]), ("manual", "Classify"))
        self.assertEqual((ins["roi2"]["source"], ins["roi2"]["via"]), ("bulk", "Dedup"))

    def test_label_bulk_endpoint_records_the_page(self) -> None:
        f = self.frames
        r = self.client.post("/api/cameras/camA/classify/label-bulk", json={"feature": "roi1", "frames": [f[0]], "cls": "NG", "via": "Dedup"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.item(f[0])["inputs"][0]["via"], "Dedup")

    def test_decision_resolves_a_contradiction_and_goes_stale_when_inputs_change(self) -> None:
        f = self.frames[0]
        self.label("roi1", f, "OK")
        self.label("roi2", f, "NG")
        r = self.client.put("/api/cameras/camA/verdicts/decision", json={"frame": f, "cls": "NG"})
        self.assertEqual(r.status_code, 200)
        item = r.json()["item"]
        self.assertEqual((item["status"], item["kind"], item["verdict"]), ("ng", "manual", "NG"))
        self.label("roi1", f, "NG")  # an input changed after the decision
        item = self.item(f)
        self.assertEqual((item["status"], item["decision"]), ("stale", "NG"))
        self.assertEqual(self.summary()["stale"], 1)
        # confirming re-snapshots the inputs
        self.client.put("/api/cameras/camA/verdicts/decision", json={"frame": f, "cls": "NG"})
        self.assertEqual(self.item(f)["status"], "ng")
        # clearing falls back to the rule
        self.client.put("/api/cameras/camA/verdicts/decision", json={"frame": f, "cls": None})
        self.assertEqual((self.item(f)["status"], self.item(f)["kind"]), ("ng", "auto"))

    def test_decision_validation(self) -> None:
        self.assertEqual(self.client.put("/api/cameras/camA/verdicts/decision", json={"frame": self.frames[0], "cls": "MAYBE"}).status_code, 422)
        self.assertEqual(self.client.put("/api/cameras/camA/verdicts/decision", json={"frame": "nope.png", "cls": "OK"}).status_code, 404)

    def test_deleted_leave_the_count_and_muted_open_become_duplicates(self) -> None:
        f = self.frames
        self.client.post("/api/cameras/camA/classify/delete-bulk", json={"feature": "roi1", "frames": [f[0]]})
        con = db.connect()
        con.execute("INSERT INTO dedup_mute(camera,feature,frame,hash,cluster_id,source,updated) VALUES('camA','roi1',?,'',1,'t',0)", (f[1],))
        con.execute("INSERT INTO dedup_mute(camera,feature,frame,hash,cluster_id,source,updated) VALUES('camA','roi1',?,'',1,'t',0)", (f[2],))
        con.commit()
        con.close()
        self.label("roi1", f[2], "OK")  # muted but labelled: keeps its verdict
        s = self.summary()
        self.assertEqual((s["deleted"], s["total"], s["duplicates"], s["ok"], s["open"]), (1, 5, 1, 1, 3))
        self.assertEqual(self.item(f[1])["muted_in"], ["roi1"])
        self.assertEqual(self.item(f[2])["verdict"], "OK")
        ids = [i["frame"] for i in self.client.get("/api/cameras/camA/verdicts?status=duplicates").json()["items"]]
        self.assertEqual(ids, [f[1]])

    def test_classify_role_roi_and_other_classes_are_ignored(self) -> None:
        f = self.frames[0]
        self.client.put("/api/cameras/camA/rois", json={**BOX, "name": "prod", "role": "classify", "classes": ["A", "B"]})
        self.client.put("/api/cameras/camA/rois", json={**BOX, "name": "defect", "classes": ["scratch", "dent"]})
        self.label("prod", f, "A")
        self.label("defect", f, "scratch")
        self.assertEqual(self.item(f)["status"], "open")

    def test_paging_filter_and_unknown_status(self) -> None:
        for fr in self.frames[:3]:
            self.label("roi1", fr, "OK")
        body = self.client.get("/api/cameras/camA/verdicts?status=ok&per_page=2&page=2").json()
        self.assertEqual((body["total"], body["n_pages"], len(body["items"])), (3, 2, 1))
        self.assertEqual(self.client.get("/api/cameras/camA/verdicts?status=weird").status_code, 422)

    def test_grid_settings_are_stored_and_used_by_default(self) -> None:
        for fr in self.frames[:3]:
            self.label("roi1", fr, "OK")
        base = "/api/cameras/camA/verdicts"
        first = self.client.get(f"{base}?status=ok").json()
        self.assertEqual((first["settings"]["per_page"], first["settings"]["cols"]), (24, 4))
        r = self.client.put(f"{base}/grid-settings", json={"per_page": 12, "cols": 6})
        self.assertEqual((r.json()["per_page"], r.json()["cols"]), (12, 6))
        again = self.client.get(f"{base}?status=ok").json()
        self.assertEqual((again["per_page"], again["settings"]["cols"]), (12, 6))
        self.assertEqual(self.client.put(f"{base}/grid-settings", json={"per_page": 7, "cols": 6}).status_code, 422)

    def test_overview_carries_the_summary(self) -> None:
        self.label("roi1", self.frames[0], "NG")
        v = self.client.get("/api/overview").json()["cameras"][0]["verdicts"]
        self.assertEqual((v["ng"], v["open"], v["deleted"]), (1, 5, 0))


class SchemaV8MigrationTests(ApiTestCase):
    def test_v7_database_gets_via_and_decisions_and_keeps_labels(self) -> None:
        import sqlite3

        path = db.db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            path.unlink()
        raw = sqlite3.connect(str(path))
        raw.executescript(
            "CREATE TABLE labels (camera TEXT NOT NULL, feature TEXT NOT NULL, frame TEXT NOT NULL, "
            "hash TEXT NOT NULL DEFAULT '', class TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', "
            "updated REAL NOT NULL, PRIMARY KEY (camera, feature, frame));"
            "INSERT INTO labels VALUES ('camA','roi1','a.png','h','OK','manual',1.0);"
            "PRAGMA user_version = 7;"
        )
        raw.commit()
        raw.close()
        con = db.connect()
        try:
            cols = {r[1] for r in con.execute("PRAGMA table_info(labels)")}
            self.assertIn("via", cols)
            self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], db.SCHEMA_VERSION)
            self.assertEqual(con.execute("SELECT class, via FROM labels").fetchone()[:], ("OK", ""))
            con.execute("SELECT * FROM verdict_decisions").fetchall()
        finally:
            con.close()
