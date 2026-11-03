"""Models: saved, named sets of pinned step-2 freezes, built into DS collection zips (plan ``plans/dataset-collection.md``, stage 3)."""
from __future__ import annotations

import json
import time
import zipfile
from pathlib import Path

import config
import datamodel
import db
import model_store
from tests.api_helpers import ApiTestCase
from tests.test_model_sets import freeze, write_frames


class ModelApiCase(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.a = write_frames("camA", (200, 200), 4, "a")
        self.b = write_frames("camB", (200, 200), 2, "b")
        self.fa = freeze("camA", [(self.a[0], "OK"), (self.a[1], "OK"), (self.a[2], "NG"), (self.a[3], "OK")], boxed=self.a[:3])
        self.fb = freeze("camB", [(self.b[0], "OK"), (self.b[1], "NG")], boxed=self.b)

    def pins(self, **kw) -> list[dict]:
        return [{"camera": "camA", "version_id": self.fa["id"], **kw.get("a", {})}, {"camera": "camB", "version_id": self.fb["id"], **kw.get("b", {})}]

    def create(self, name: str = "Round one", **kw):
        return self.client.post("/api/models", json={"name": name, "datasets": self.pins(), **kw})

    def delete_freeze(self, version_id: int) -> None:
        con = db.connect()
        try:
            con.execute("UPDATE versions SET deleted=? WHERE id=?", (time.time(), version_id))
            con.commit()
        finally:
            con.close()


class CreateAndReadTests(ModelApiCase):
    def test_a_model_keeps_its_datasets_in_order_with_prefixed_class_names_by_default(self) -> None:
        r = self.create()
        self.assertEqual(r.status_code, 201, r.text)
        m = r.json()
        self.assertEqual((m["name"], m["builds"], m["include_without_box"]), ("Round one", 0, False))
        self.assertEqual([(d["camera"], d["folder_name"], d["ok_name"], d["ng_name"]) for d in m["datasets"]],
                         [("camA", "camA", "camA-OK", "camA-NG"), ("camB", "camB", "camB-OK", "camB-NG")])
        self.assertEqual([(d["ok"], d["ng"], d["no_rect"], d["size"]) for d in m["datasets"]], [(2, 1, 1, "200x200"), (1, 1, 0, "200x200")])
        self.assertEqual([c["name"] for c in m["classes"]], ["camA-OK", "camA-NG", "camB-OK", "camB-NG"])
        self.assertEqual(m["next_build"], {"number": 1, "collection_name": "Round one_v001"})
        self.assertEqual((m["changed"], m["stale"]), (False, []))
        got = self.client.get(f"/api/models/{m['id']}").json()
        self.assertEqual(got["datasets"], m["datasets"])
        listed = self.client.get("/api/models").json()["models"]
        self.assertEqual([(x["name"], x["dataset_count"], x["builds"], x["last_build"]) for x in listed], [("Round one", 2, 0, None)])

    def test_equal_class_names_are_one_shared_class(self) -> None:
        pins = self.pins(a={"ok_name": "OK", "ng_name": "NG"}, b={"ok_name": "ok", "ng_name": "ng"})
        m = self.client.post("/api/models", json={"name": "shared", "datasets": pins}).json()
        self.assertEqual([(c["name"], c["datasets"]) for c in m["classes"]], [("OK", ["camA", "camB"]), ("NG", ["camA", "camB"])])

    def test_bad_requests_are_refused_with_a_message(self) -> None:
        good = self.pins()
        cases = (
            ({"name": " ", "datasets": good}, "name is empty"),
            ({"name": "x", "datasets": []}, "at least one dataset"),
            ({"name": "x", "datasets": [good[0], {**good[1], "camera": "camA"}]}, "One freeze per camera"),
            ({"name": "x", "datasets": [{"camera": "camA", "version_id": 999}]}, "freeze 999"),
            ({"name": "x", "datasets": [{"camera": "nope", "version_id": 1}]}, "No such camera"),
            ({"name": "x", "datasets": [{**good[0], "ng_color": "red"}]}, "NG colour"),
            ({"name": "x", "datasets": [{**good[0], "ok_name": "same", "ng_name": "SAME"}]}, "must differ"),
            ({"name": "x", "datasets": [{**good[0], "folder_name": "one"}, {**good[1], "folder_name": "ONE"}]}, "'one' and 'ONE'"),
            ({"name": "x" * 81, "datasets": good}, "longer than"),
        )
        for body, text in cases:
            r = self.client.post("/api/models", json=body)
            self.assertEqual(r.status_code, 422, (body, r.text))
            self.assertIn(text, r.json()["detail"])

    def test_a_step_one_freeze_cannot_be_pinned(self) -> None:
        plain = freeze("camB", [(self.b[0], "OK")], boxed=[], rectangles=False)
        r = self.client.post("/api/models", json={"name": "x", "datasets": [{"camera": "camB", "version_id": plain["id"]}]})
        self.assertEqual(r.status_code, 422)
        self.assertIn("not a step-2 freeze with rectangles", r.json()["detail"])

    def test_names_are_unique_ignoring_case_and_by_folder(self) -> None:
        self.assertEqual(self.create("Round one").status_code, 201)
        again = self.create("ROUND ONE")
        self.assertEqual(again.status_code, 422)
        self.assertIn("already exists", again.json()["detail"])
        self.assertEqual(self.create("a/b").status_code, 201)
        clash = self.create("a-b")
        self.assertEqual(clash.status_code, 422)
        self.assertIn("folder name", clash.json()["detail"])

    def test_an_unknown_model_is_404(self) -> None:
        for method, url in (("get", "/api/models/99"), ("post", "/api/models/99/build"), ("get", "/api/models/99/builds"), ("get", "/api/models/99/builds/1")):
            self.assertEqual(getattr(self.client, method)(url).status_code, 404, url)

    def test_the_preview_shows_the_classes_without_reading_a_freeze(self) -> None:
        r = self.client.post("/api/models/preview", json={"datasets": [
            {"camera": "x", "version_id": 1, "ok_name": "Good", "ng_name": "Bad"}, {"camera": "y", "version_id": 2, "ok_name": "Good", "ng_name": "Worse", "ok_color": "#010203"},
        ]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([(c["name"], c["datasets"]) for c in r.json()["classes"]], [("Good", ["x", "y"]), ("Bad", ["x"]), ("Worse", ["y"])])
        self.assertTrue(any("'Good' has two colours" in n for n in r.json()["notes"]))
        bad = self.client.post("/api/models/preview", json={"datasets": [{"camera": "x", "version_id": 1, "ok_color": "nope"}]})
        self.assertEqual(bad.status_code, 422)


class UpdateAndStateTests(ModelApiCase):
    def test_update_changes_what_is_given(self) -> None:
        m = self.create().json()
        r = self.client.put(f"/api/models/{m['id']}", json={"name": "Round 1", "include_without_box": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["name"], r.json()["include_without_box"], len(r.json()["datasets"])), ("Round 1", True, 2))
        r = self.client.put(f"/api/models/{m['id']}", json={"datasets": [{"camera": "camB", "version_id": self.fb["id"], "folder_name": "b only"}]})
        self.assertEqual([(d["camera"], d["folder_name"]) for d in r.json()["datasets"]], [("camB", "b only")])
        self.assertEqual(self.client.put(f"/api/models/{m['id']}", json={"name": ""}).status_code, 422)
        self.assertEqual(self.client.put("/api/models/99", json={"name": "x"}).status_code, 404)

    def test_a_newer_freeze_and_a_deleted_one_are_shown_and_the_pin_stays(self) -> None:
        m = self.create().json()
        newer = freeze("camA", [(self.a[0], "OK")], boxed=[self.a[0]], sizes={"200x200": 1})
        got = self.client.get(f"/api/models/{m['id']}").json()
        da = got["datasets"][0]
        self.assertEqual((da["version_id"], da["newer"]["id"], da["gone"]), (self.fa["id"], newer["id"], False))
        self.assertEqual(got["stale"], ["camA"])
        self.delete_freeze(self.fb["id"])
        got = self.client.get(f"/api/models/{m['id']}").json()
        self.assertEqual((got["datasets"][1]["gone"], got["datasets"][1]["number"]), (True, None))
        self.assertEqual(got["stale"], ["camA", "camB"])


class BuildTests(ModelApiCase):
    def test_a_build_writes_the_zip_under_the_model_folder_and_records_it(self) -> None:
        m = self.create().json()
        r = self.client.post(f"/api/models/{m['id']}/build")
        self.assertEqual(r.status_code, 201, r.text)
        b = r.json()
        self.assertEqual((b["number"], b["collection_name"], b["written"], b["exists"]), (1, "Round one_v001", 5, True))
        self.assertEqual(b["zip"], "models/Round one/Round one_v001.zip")
        zip_file = config.DATA_DIR / b["zip"]
        with zipfile.ZipFile(zip_file) as z:
            data = json.loads(z.read("datasetCollection.json"))
            self.assertEqual(sorted(n for n in z.namelist() if n != "datasetCollection.json"), sorted([*[f"camA/{n}" for n in self.a[:3]], *[f"camB/{n}" for n in self.b]]))
            self.assertEqual(z.read(f"camB/{self.b[0]}"), (datamodel.unsorted_dir("camB") / self.b[0]).read_bytes())
        self.assertEqual(data["Name"], "Round one_v001")
        self.assertEqual(b["report"]["written"], 5)
        self.assertEqual(b["datasets"][0]["camera"], "camA")
        after = self.client.get(f"/api/models/{m['id']}").json()
        self.assertEqual((after["builds"], after["last_build"]["number"], after["changed"]), (1, 1, False))
        self.assertEqual(after["next_build"], {"number": 2, "collection_name": "Round one_v002"})

    def test_every_build_gets_its_own_number_and_collection_name(self) -> None:
        m = self.create().json()
        first = self.client.post(f"/api/models/{m['id']}/build").json()
        second = self.client.post(f"/api/models/{m['id']}/build").json()
        self.assertEqual((first["number"], second["number"]), (1, 2))
        self.assertNotEqual(first["zip"], second["zip"])
        with zipfile.ZipFile(config.DATA_DIR / second["zip"]) as z:
            self.assertEqual(json.loads(z.read("datasetCollection.json"))["Name"], "Round one_v002")
        listed = self.client.get(f"/api/models/{m['id']}/builds").json()["builds"]
        self.assertEqual([x["number"] for x in listed], [2, 1])
        self.assertEqual(self.client.get(f"/api/models/{m['id']}/builds/1").json()["collection_name"], "Round one_v001")
        self.assertEqual(self.client.get(f"/api/models/{m['id']}/builds/7").status_code, 404)

    def test_the_manifest_is_kept_and_can_be_paged(self) -> None:
        m = self.create().json()
        self.client.post(f"/api/models/{m['id']}/build")
        full = self.client.get(f"/api/models/{m['id']}/builds/1/manifest").json()
        self.assertEqual((full["total"], len(full["rows"])), (5, 5))
        row = next(r for r in full["rows"] if r["frame"] == self.a[2])
        self.assertEqual((row["camera"], row["version"], row["dataset"], row["file"], row["class"], row["ds_class"], row["box"]),
                         ("camA", self.fa["id"], "camA", self.a[2], "NG", "camA-NG", [1, 1, 20, 20]))
        self.assertTrue(row["hash"])
        page = self.client.get(f"/api/models/{m['id']}/builds/1/manifest", params={"offset": 3, "limit": 10}).json()
        self.assertEqual((page["total"], page["offset"], len(page["rows"])), (5, 3, 2))
        self.assertEqual(page["rows"], full["rows"][3:])

    def test_a_changed_model_says_so_until_it_is_built_again(self) -> None:
        m = self.create().json()
        self.client.post(f"/api/models/{m['id']}/build")
        self.client.put(f"/api/models/{m['id']}", json={"datasets": [{"camera": "camA", "version_id": self.fa["id"], "ok_name": "Good"}, {"camera": "camB", "version_id": self.fb["id"]}]})
        self.assertTrue(self.client.get(f"/api/models/{m['id']}").json()["changed"])
        self.client.post(f"/api/models/{m['id']}/build")
        self.assertFalse(self.client.get(f"/api/models/{m['id']}").json()["changed"])

    def test_the_include_tick_adds_pictures_without_a_rectangle(self) -> None:
        m = self.create(include_without_box=True).json()
        b = self.client.post(f"/api/models/{m['id']}/build").json()
        self.assertEqual(b["written"], 6)
        self.assertTrue(b["include_without_box"])
        rows = self.client.get(f"/api/models/{m['id']}/builds/1/manifest").json()["rows"]
        self.assertEqual([r["frame"] for r in rows if r["box"] is None], [self.a[3]])

    def test_a_failed_build_writes_nothing_and_uses_no_number(self) -> None:
        m = self.create().json()
        self.delete_freeze(self.fb["id"])
        r = self.client.post(f"/api/models/{m['id']}/build")
        self.assertEqual(r.status_code, 422)
        self.assertIn("camB", r.json()["detail"])
        self.assertFalse((config.DATA_DIR / "models").exists())
        self.assertEqual(self.client.get(f"/api/models/{m['id']}").json()["builds"], 0)
        self.client.put(f"/api/models/{m['id']}", json={"datasets": [{"camera": "camA", "version_id": self.fa["id"]}]})
        self.assertEqual(self.client.post(f"/api/models/{m['id']}/build").json()["number"], 1)

    def test_a_renamed_model_keeps_its_old_zips_and_builds_into_the_new_folder(self) -> None:
        m = self.create().json()
        old = self.client.post(f"/api/models/{m['id']}/build").json()
        self.client.put(f"/api/models/{m['id']}", json={"name": "Round 1"})
        new = self.client.post(f"/api/models/{m['id']}/build").json()
        self.assertEqual((new["number"], new["zip"]), (2, "models/Round 1/Round 1_v002.zip"))
        self.assertTrue((config.DATA_DIR / old["zip"]).exists())
        self.assertTrue(self.client.get(f"/api/models/{m['id']}/builds/1").json()["exists"])

    def test_the_zip_can_be_downloaded_and_a_removed_one_is_404(self) -> None:
        m = self.create().json()
        b = self.client.post(f"/api/models/{m['id']}/build").json()
        r = self.client.get(f"/api/models/{m['id']}/builds/1/zip")
        self.assertEqual((r.status_code, r.headers["content-type"]), (200, "application/zip"))
        self.assertEqual(r.content, (config.DATA_DIR / b["zip"]).read_bytes())
        (config.DATA_DIR / b["zip"]).unlink()
        self.assertEqual(self.client.get(f"/api/models/{m['id']}/builds/1/zip").status_code, 404)
        self.assertFalse(self.client.get(f"/api/models/{m['id']}/builds/1").json()["exists"])

    def test_the_manifest_survives_deleting_a_camera(self) -> None:
        m = self.create().json()
        self.client.post(f"/api/models/{m['id']}/build")
        db.delete_camera_rows("camB")
        rows = self.client.get(f"/api/models/{m['id']}/builds/1/manifest").json()["rows"]
        self.assertEqual({r["camera"] for r in rows}, {"camA", "camB"})  # the record of what went into the build stays


class SchemaTests(ModelApiCase):
    def test_an_older_database_gets_the_model_tables_by_migration(self) -> None:
        con = db.connect()
        try:
            for table in ("model_build_items", "model_builds", "models"):
                con.execute(f"DROP TABLE {table}")
            con.execute("PRAGMA user_version = 10")
            con.commit()
        finally:
            con.close()
        con = db.connect()  # connecting upgrades 10 -> 11
        try:
            tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertTrue({"models", "model_builds", "model_build_items"} <= tables)
            self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], db.SCHEMA_VERSION)
        finally:
            con.close()
        self.assertEqual(self.client.get("/api/models").json(), {"models": []})


class FolderNameTests(ModelApiCase):
    def test_a_folder_name_drops_what_a_file_name_cannot_hold(self) -> None:
        self.assertEqual(model_store.folder_name('a/b:c*"d'), "a-b-c--d")
        self.assertEqual(model_store.folder_name("  x. "), "x")
        self.assertEqual(model_store.folder_name("...", 7), "model-7")
        self.assertEqual(Path(model_store.models_dir()).name, "models")
