"""The view of a Dedup box (v1.138.0): what it offers, how it cuts, which pictures pass. Temp roots only."""
from __future__ import annotations

import cv2
import numpy as np

import datamodel
import db
import dedup_basis
import dedup_box
import dedup_view
import flow
import ingest
import labels
import roi_input
from tests.api_helpers import ApiTestCase, wait_for_job
from tests.test_rotsearch import component, turned

CAM = "camV"
LEFT_BOX = [30, 96, 62, 48]
RIGHT_BOX = [148, 96, 62, 48]
ANGLES = [0.0, 2.0, 30.0, 358.0]


class DedupViewTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        picture, _, _ = component()
        datamodel.ensure_camera_dirs(CAM)
        self.names = []
        for i, angle in enumerate(ANGLES):
            name = f"part_{i}.png"
            cv2.imwrite(str(datamodel.unsorted_dir(CAM) / name), picture if angle == 0.0 else turned(picture, angle, seed=i))
            self.names.append(name)
        ingest.rebuild_index(CAM)
        self.base = f"/api/cameras/{CAM}"
        self.flow = f"{self.base}/flow"

    def test_evaluation_is_kept_between_requests_and_follows_changes(self) -> None:
        """Worked out once while nothing it reads has changed; a write or a new picture makes it new again (v1.139.3)."""
        import time

        _, ev, _ = self.chain()
        folder = datamodel.unsorted_dir(CAM)
        old = time.time() - 60
        import os

        os.utime(folder, (old, old))  # settled: a folder changed a moment ago is never kept
        flow._EVAL_MEMORY.clear()
        calls = []
        real = flow._evaluation_state
        flow._evaluation_state = lambda c, e: (calls.append(e), real(c, e))[1]
        try:
            first = flow.evaluation_state(CAM, ev)
            again = flow.evaluation_state(CAM, ev)
            self.assertEqual(len(calls), 1)
            self.assertEqual(first["verdicts"], again["verdicts"])
            again["verdicts"].clear()  # a caller changing its copy must not change the kept answer
            self.assertTrue(flow.evaluation_state(CAM, ev)["verdicts"])
            self.assertEqual(len(calls), 1)
            flow.update_node(CAM, ev, {"nominal": 0.0, "tolerance": 0.001})  # a write: new answer
            os.utime(folder, (old, old))
            changed = flow.evaluation_state(CAM, ev)
            self.assertEqual(len(calls), 2)
            self.assertNotEqual(changed["counts"], first["counts"])
        finally:
            flow._evaluation_state = real

    # --- helpers -----------------------------------------------------------------
    def post(self, path: str, body: dict | None = None, status: int = 201) -> dict:
        r = self.client.post(f"{self.flow}{path}", json=body or {})
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    def node(self, kind: str) -> str:
        return self.post("/nodes", {"kind": kind})["id"]

    def detector(self, parent: str = "ingest") -> str:
        det = self.node("detector")
        for name, box in (("A", LEFT_BOX), ("B", RIGHT_BOX)):
            self.post(f"/nodes/{det}/targets", {"name": name})
            self.post(f"/nodes/{det}/examples", {"target": name, "frame": self.names[0], "box": box})
        self.post("/edges", {"source": parent, "target": det})
        return det

    def run_all(self) -> None:
        job = self.post("/run", status=202)
        self.assertEqual(wait_for_job(self.client, job["id"])["status"], "done")

    def chain(self) -> tuple[str, str, str]:
        """Ingest -> Detector -> Calculate -> Evaluation (pass dot) -> Dedup. Returns (detector, evaluation, dedup)."""
        det = self.detector()
        calc = self.node("calc")
        self.post("/edges", {"source": det, "target": calc})
        ev = self.node("evaluation")
        self.post("/edges", {"source": calc, "target": ev})
        flow.update_node(CAM, ev, {"nominal": 0.0, "tolerance": 180.0})
        dedup = self.node("dedup")
        flow.update_node(CAM, dedup, {"source": {"box": ev, "dot": "pass"}})
        self.run_all()
        return det, ev, dedup

    def chain_with_spare_target(self) -> tuple[str, str]:
        """Like ``chain`` but Calculate reads only A and B; target C is spare, so losing its box leaves the Evaluation alone."""
        det = self.detector()
        self.post(f"/nodes/{det}/targets", {"name": "C"})
        self.post(f"/nodes/{det}/examples", {"target": "C", "frame": self.names[0], "box": LEFT_BOX})
        calc = self.node("calc")
        for point in ("A", "B"):
            self.post("/edges", {"source": det, "target": calc, "point": point})
        ev = self.node("evaluation")
        self.post("/edges", {"source": calc, "target": ev})
        flow.update_node(CAM, ev, {"nominal": 0.0, "tolerance": 180.0})
        dedup = self.node("dedup")
        flow.update_node(CAM, dedup, {"source": {"box": ev, "dot": "pass"}})
        self.run_all()
        return det, dedup

    def lose_box(self, det: str, target: str, name: str) -> None:
        stored = flow.load_stored(CAM, det)
        stored["frames"][labels.hash_map(CAM)[name]].pop(target)
        flow._store(CAM, det, stored["sig"], stored["frames"])

    def mute(self, box: str, frames: list[str]) -> None:
        db.add_dedup_mutes(CAM, box, [(f, db.frame_hash_for(CAM, f), 1) for f in frames])

    def ids(self, box: str) -> list:
        return [c["id"] for c in dedup_view.candidates(CAM, box)]

    # --- what is offered ----------------------------------------------------------
    def test_a_box_offers_the_whole_picture_and_the_boxes_found_above_it(self) -> None:
        det, _, dedup = self.chain()
        self.assertEqual(self.ids(dedup), [None, f"{det}/A", f"{det}/B"])

    def test_crops_above_are_offered_and_another_branch_is_not(self) -> None:
        crop = self.node("crop")
        self.post("/edges", {"source": "ingest", "target": crop})
        flow.update_node(CAM, crop, {"rect": [0.0, 0.0, 1.0, 0.9]})
        det = self.detector(parent=crop)
        other_crop = self.node("crop")
        self.post("/edges", {"source": "ingest", "target": other_crop})
        flow.update_node(CAM, other_crop, {"rect": [0.0, 0.0, 0.5, 0.5]})
        other_det = self.detector(parent=other_crop)
        calc = self.node("calc")
        self.post("/edges", {"source": det, "target": calc})
        ev = self.node("evaluation")
        self.post("/edges", {"source": calc, "target": ev})
        dedup = self.node("dedup")
        flow.update_node(CAM, dedup, {"source": {"box": ev, "dot": "pass"}})
        offered = self.ids(dedup)
        self.assertIn(crop, offered)
        self.assertIn(f"{det}/A", offered)
        self.assertNotIn(other_crop, offered)
        self.assertFalse([i for i in offered if i and i.startswith(other_det)])

    def test_a_crop_that_only_filters_is_not_a_view_and_a_dedup_box_never_is(self) -> None:
        crop = self.node("crop")
        self.post("/edges", {"source": "ingest", "target": crop})
        flow.update_node(CAM, crop, {"steps": [{"op": "filter", "name": "gaussian"}]})
        first = self.node("dedup")
        self.post("/edges", {"source": "ingest", "target": first})
        second = self.node("dedup")
        flow.update_node(CAM, second, {"source": {"box": self.chain()[1], "dot": "pass"}})
        self.assertNotIn(crop, self.ids(second))  # filters only: the whole picture again
        self.assertNotIn(first, self.ids(second))
        self.assertNotIn(crop, self.ids(second))

    # --- cutting ------------------------------------------------------------------
    def test_a_found_box_is_cut_upright_whatever_the_part_turn(self) -> None:
        det, _, dedup = self.chain()
        out = dedup_box.set_view(CAM, dedup, f"{det}/A")
        self.assertTrue(out["changed"])
        cuts = []
        for name in self.names:
            image = cv2.imread(str(datamodel.unsorted_dir(CAM) / name))
            piece = roi_input.edited(CAM, dedup, image, name)
            self.assertEqual(piece.shape[:2], (LEFT_BOX[3], LEFT_BOX[2]), name)
            cuts.append(cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY).astype(float))
        for other in cuts[1:]:  # the same part, turned back, looks like the upright one
            self.assertGreater(np.corrcoef(cuts[0].ravel(), other.ravel())[0, 1], 0.6)

    def test_no_view_means_the_picture_as_before(self) -> None:
        _, _, dedup = self.chain()
        image = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.names[0]))
        self.assertIs(roi_input.edited(CAM, dedup, image, self.names[0]), image)
        self.assertEqual(dedup_view.rule_key(CAM, dedup), "")

    def test_the_cache_key_follows_the_view(self) -> None:
        det, _, dedup = self.chain()
        dedup_box.set_view(CAM, dedup, f"{det}/A")
        key_a = roi_input.rule_key(CAM, dedup)
        dedup_box.set_view(CAM, dedup, f"{det}/B")
        self.assertTrue(key_a)
        self.assertNotEqual(key_a, roi_input.rule_key(CAM, dedup))

    def test_the_cutout_endpoint_serves_the_view(self) -> None:
        det, _, dedup = self.chain()
        dedup_box.set_view(CAM, dedup, f"{det}/B")
        r = self.client.get(f"{self.base}/frames/{self.names[2]}/cutout", params={"feature": dedup})
        self.assertEqual(r.status_code, 200, r.text)
        piece = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(piece.shape[:2], (RIGHT_BOX[3], RIGHT_BOX[2]))

    # --- which pictures pass ------------------------------------------------------
    def test_a_picture_without_the_found_box_does_not_pass_and_is_counted(self) -> None:
        det, dedup = self.chain_with_spare_target()
        before = flow.node_frames(CAM, dedup)
        self.assertEqual(sorted(before), sorted(self.names))
        dedup_box.set_view(CAM, dedup, f"{det}/C")
        self.assertEqual(sorted(flow.node_frames(CAM, dedup)), sorted(self.names))
        self.lose_box(det, "C", self.names[1])
        passing = flow.node_frames(CAM, dedup)
        self.assertNotIn(self.names[1], passing)
        self.assertEqual(len(passing), len(before) - 1)
        self.assertEqual(dedup_view.summary(CAM, dedup)["no_view"], 1)
        self.assertEqual(len(dedup_box.frames(CAM, dedup)), len(before) - 1)

    def test_the_boxes_after_a_dedup_see_only_the_pictures_that_have_the_view(self) -> None:
        det, dedup = self.chain_with_spare_target()
        dedup_box.set_view(CAM, dedup, f"{det}/C")
        self.lose_box(det, "C", self.names[0])
        later = self.node("dedup")
        self.post("/edges", {"source": dedup, "target": later})
        self.assertNotIn(self.names[0], flow.node_frames(CAM, later))
        self.assertIn(self.names[1], flow.node_frames(CAM, later))

    # --- the line decides ---------------------------------------------------------
    def test_a_line_that_carries_a_view_decides_and_the_list_is_read_only(self) -> None:
        crop = self.node("crop")
        self.post("/edges", {"source": "ingest", "target": crop})
        flow.update_node(CAM, crop, {"rect": [0.0, 0.0, 0.5, 0.5]})
        dedup = self.node("dedup")
        self.post("/edges", {"source": crop, "target": dedup})
        summary = dedup_view.summary(CAM, dedup)
        self.assertTrue(summary["locked_by"])
        with self.assertRaises(dedup_box.DedupBoxError):
            dedup_box.set_view(CAM, dedup, None if not self.ids(dedup)[1:] else self.ids(dedup)[1])

    def test_a_view_that_is_not_above_the_box_is_refused(self) -> None:
        _, _, dedup = self.chain()
        with self.assertRaises(dedup_box.DedupBoxError):
            dedup_box.set_view(CAM, dedup, "det:99/A")

    # --- changing the view with mutes ---------------------------------------------
    def test_changing_the_view_with_mutes_asks_first_and_then_forgets_them(self) -> None:
        det, _, dedup = self.chain()
        self.mute(dedup, self.names[:2])
        asked = dedup_box.set_view(CAM, dedup, f"{det}/A")
        self.assertEqual(asked, {"changed": False, "mutes": 2})
        self.assertIsNone(dedup_view.selected(CAM, dedup))
        self.assertEqual(len(db.muted_frames(CAM, dedup)), 2)
        done = dedup_box.set_view(CAM, dedup, f"{det}/A", confirm=True)
        self.assertEqual(done, {"changed": True, "mutes": 2})
        self.assertEqual(dedup_view.selected(CAM, dedup), f"{det}/A")
        self.assertEqual(len(db.muted_frames(CAM, dedup)), 0)

    def test_without_mutes_the_change_needs_no_question(self) -> None:
        det, _, dedup = self.chain()
        self.assertEqual(dedup_box.set_view(CAM, dedup, f"{det}/A"), {"changed": True, "mutes": 0})
        self.assertEqual(dedup_box.set_view(CAM, dedup, f"{det}/A"), {"changed": False, "mutes": 0})  # nothing to change
        self.assertTrue(dedup_box.set_view(CAM, dedup, None)["changed"])

    # --- the API ------------------------------------------------------------------
    def test_the_state_and_the_view_endpoint(self) -> None:
        det, _, dedup = self.chain()
        state = self.client.get(f"{self.base}/dedup/state", params={"feature": dedup}).json()
        self.assertEqual([c["id"] for c in state["view"]["candidates"]], [None, f"{det}/A", f"{det}/B"])
        self.assertIsNone(state["view"]["selected"])
        r = self.client.put(f"{self.base}/dedup/view", json={"feature": dedup, "view": f"{det}/A"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["changed"])
        self.assertEqual(r.json()["view"]["selected"], f"{det}/A")
        self.assertTrue(r.json()["view"]["key"])  # the page puts it into thumbnail addresses
        first = r.json()["view"]["key"]
        self.assertNotEqual(self.client.put(f"{self.base}/dedup/view", json={"feature": dedup, "view": f"{det}/B"}).json()["view"]["key"], first)
        bad = self.client.put(f"{self.base}/dedup/view", json={"feature": dedup, "view": "det:77/A"})
        self.assertEqual(bad.status_code, 422)
        unknown = self.client.put(f"{self.base}/dedup/view", json={"feature": "dedup:99", "view": None})
        self.assertEqual(unknown.status_code, 404)


    # --- what changed since the last clustering (v1.139.0) -------------------------
    def test_nothing_is_flagged_before_a_clustering_and_after_one_with_nothing_changed(self) -> None:
        _, _, dedup = self.chain()
        self.assertIsNone(dedup_basis.compare(CAM, dedup))
        dedup_basis.save(CAM, dedup)
        self.assertEqual(dedup_basis.compare(CAM, dedup), {"view_changed": False, "set_changed": False, "changes": []})

    def test_a_detector_that_ran_again_changes_the_view_and_the_set_and_is_named(self) -> None:
        det, dedup = self.chain_with_spare_target()
        dedup_box.set_view(CAM, dedup, f"{det}/C")
        dedup_basis.save(CAM, dedup)
        self.lose_box(det, "C", self.names[1])
        flagged = dedup_basis.compare(CAM, dedup)
        self.assertTrue(flagged["view_changed"])
        self.assertTrue(flagged["set_changed"])
        self.assertIn("Detector 1 was run again", flagged["changes"])

    def test_a_tolerance_change_that_moves_pictures_is_a_set_change_and_one_that_does_not_is_not_flagged(self) -> None:
        _, ev, dedup = self.chain()
        dedup_basis.save(CAM, dedup)
        flow.update_node(CAM, ev, {"tolerance": 170.0})  # every picture still passes
        self.assertEqual(dedup_basis.compare(CAM, dedup), {"view_changed": False, "set_changed": False, "changes": []})
        flow.update_node(CAM, ev, {"tolerance": 0.001})
        flagged = dedup_basis.compare(CAM, dedup)
        self.assertTrue(flagged["set_changed"])
        self.assertFalse(flagged["view_changed"])
        self.assertIn(f"Evaluation {ev.split(':')[1]} tolerance changed", flagged["changes"])

    def test_the_mutes_of_a_dedup_box_above_change_the_set_of_the_one_below(self) -> None:
        first = self.node("dedup")
        self.post("/edges", {"source": "ingest", "target": first})
        second = self.node("dedup")
        self.post("/edges", {"source": first, "target": second})
        dedup_basis.save(CAM, second)
        self.mute(first, self.names[:1])
        flagged = dedup_basis.compare(CAM, second)
        self.assertTrue(flagged["set_changed"])
        self.assertIn(f"Dedup {first.split(':')[1]} muted pictures changed", flagged["changes"])

    def test_new_pictures_are_a_set_change_without_a_box_to_blame(self) -> None:
        _, _, dedup = self.chain()
        dedup_basis.save(CAM, dedup)
        picture, _, _ = component()
        cv2.imwrite(str(datamodel.unsorted_dir(CAM) / "late.png"), picture)
        ingest.rebuild_index(CAM)
        flow.update_node(CAM, dedup, {"source": {"box": flow.load_graph(CAM)["nodes"][dedup]["source"]["box"], "dot": "fail"}})  # another dot: another set
        flagged = dedup_basis.compare(CAM, dedup)
        self.assertTrue(flagged["set_changed"])
        self.assertTrue(flagged["changes"])

    def test_the_state_carries_the_flags_and_a_new_view_forgets_the_basis(self) -> None:
        det, _, dedup = self.chain()
        state = self.client.get(f"{self.base}/dedup/state", params={"feature": dedup}).json()
        self.assertIsNone(state["changes"])
        dedup_basis.save(CAM, dedup)
        self.assertEqual(self.client.get(f"{self.base}/dedup/state", params={"feature": dedup}).json()["changes"]["set_changed"], False)
        dedup_box.set_view(CAM, dedup, f"{det}/A")
        self.assertIsNone(self.client.get(f"{self.base}/dedup/state", params={"feature": dedup}).json()["changes"])

    # --- speed (v1.139.2): the work above a Dedup box is done once per request ----------
    def test_opening_the_dedup_page_works_out_the_evaluation_once_even_with_a_view_and_a_basis(self) -> None:
        det, _, dedup = self.chain()
        dedup_box.set_view(CAM, dedup, f"{det}/A")
        dedup_basis.save(CAM, dedup)
        calls = []
        original = flow._evaluation_state
        flow._evaluation_state = lambda *a, **k: (calls.append(1), original(*a, **k))[1]
        try:
            self.assertEqual(self.client.get(f"{self.base}/dedup/state", params={"feature": dedup}).status_code, 200)
            self.assertEqual(len(calls), 1)
            calls.clear()
            self.assertEqual(self.client.get(f"{self.base}/dedup/frames", params={"feature": dedup}).status_code, 200)
            self.assertEqual(len(calls), 1)
        finally:
            flow._evaluation_state = original

    def test_picture_sizes_are_read_from_the_files_once(self) -> None:
        from PIL import Image  # noqa: PLC0415

        flow._SIZE_OF_HASH.clear()
        opened = []
        original = Image.open
        Image.open = lambda *a, **k: (opened.append(1), original(*a, **k))[1]
        try:
            first = flow._frame_sizes(CAM)
            self.assertEqual(len(opened), len(self.names))
            opened.clear()
            self.assertEqual(flow._frame_sizes(CAM), first)
            self.assertEqual(opened, [])
        finally:
            Image.open = original


def test_picture_listing_follows_the_directory(tmp_path, monkeypatch):
    """The listing is cached while the directory is unchanged and sees an added or removed picture (v1.139.3)."""
    import os
    import time

    import datamodel

    folder = tmp_path / "pics"
    folder.mkdir()
    for name in ("b.png", "a.png", "notes.txt"):
        (folder / name).write_bytes(b"x")
    old = time.time() - 60
    os.utime(folder, (old, old))
    assert [p.name for p in datamodel._list_images(folder)] == ["a.png", "b.png"]
    (folder / "c.png").write_bytes(b"x")
    os.utime(folder, (old + 10, old + 10))
    assert [p.name for p in datamodel._list_images(folder)] == ["a.png", "b.png", "c.png"]
    (folder / "a.png").unlink()
    os.utime(folder, (old + 20, old + 20))
    assert [p.name for p in datamodel._list_images(folder)] == ["b.png", "c.png"]
    assert datamodel._list_images(tmp_path / "missing") == []
