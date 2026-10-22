"""Picture Edits box (``crop`` kind): an ordered list of crop and filter steps. Temp roots only."""
from __future__ import annotations

import json

import cv2
import numpy as np

import datamodel
import flow
import ingest
import preprocess
from tests.api_helpers import ApiTestCase

CAM = "camE"
RECT = [0.25, 0.25, 0.5, 0.5]


def _decode(content: bytes) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(content, np.uint8), cv2.IMREAD_COLOR)


class PictureEditsTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        datamodel.ensure_camera_dirs(CAM)
        rng = np.random.default_rng(7)
        self.names = []
        for i in range(2):
            img = rng.integers(0, 256, (80, 120, 3), dtype=np.uint8)
            name = f"p_{i}.png"
            cv2.imwrite(str(datamodel.unsorted_dir(CAM) / name), img)
            self.names.append(name)
        ingest.rebuild_index(CAM)
        self.base = f"/api/cameras/{CAM}/flow"
        self.src = cv2.imread(str(datamodel.unsorted_dir(CAM) / self.names[0]))

    def node(self, kind: str = "crop") -> str:
        r = self.client.post(f"{self.base}/nodes", json={"kind": kind})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def steps(self, node: str, steps: list[dict], status: int = 200):
        r = self.client.put(f"{self.base}/nodes/{node}", json={"steps": steps})
        self.assertEqual(r.status_code, status, r.text)
        return r

    def detail(self, node: str) -> dict:
        return self.client.get(f"{self.base}/nodes/{node}").json()

    def picture(self, node: str, **params) -> np.ndarray:
        r = self.client.get(f"{self.base}/nodes/{node}/picture", params={"frame": self.names[0], **params})
        self.assertEqual(r.status_code, 200, r.text)
        return _decode(r.content)

    GAUSS = {"op": "filter", "name": "gaussian", "params": {"sigma": 2.0}}
    CROP = {"op": "crop", "rect": RECT}

    def _cut(self, image: np.ndarray) -> np.ndarray:
        h, w = image.shape[:2]
        x0, y0, x1, y1 = flow._pixel_box(RECT, w, h)
        return image[y0:y1, x0:x1]

    def test_a_new_box_holds_one_empty_crop_step_and_passes_the_picture_on(self) -> None:
        node = self.node()
        self.assertEqual(self.detail(node)["steps"], [{"id": "s1", "op": "crop", "rect": None}])
        self.assertTrue(np.array_equal(self.picture(node, stage="output"), self.src))

    def test_a_box_stored_with_a_single_rect_reads_as_one_crop_step(self) -> None:
        node = self.node()
        graph = flow.load_graph(CAM)
        graph["nodes"][node] = {"kind": "crop", "rect": RECT, "follow": None}  # as stored before steps existed
        flow.save_graph(CAM, graph)
        self.assertEqual(self.detail(node)["steps"], [{"id": "s1", "op": "crop", "rect": RECT}])
        self.assertTrue(np.array_equal(self.picture(node, stage="output"), self._cut(self.src)))
        self.client.put(f"{self.base}/nodes/{node}", json={"rect": None})  # the older request still works
        self.assertEqual(self.detail(node)["steps"][0]["rect"], None)
        self.assertNotIn("rect", flow.load_graph(CAM)["nodes"][node])

    def test_steps_run_in_the_order_of_the_list(self) -> None:
        node = self.node()
        self.steps(node, [self.GAUSS, self.CROP])
        blur_then_cut = self.picture(node, stage="output")
        self.assertTrue(np.array_equal(blur_then_cut, self._cut(preprocess.apply(self.src, "gaussian", {"sigma": 2.0}))))
        self.steps(node, [self.CROP, self.GAUSS])
        cut_then_blur = self.picture(node, stage="output")
        self.assertTrue(np.array_equal(cut_then_blur, preprocess.apply(self._cut(self.src), "gaussian", {"sigma": 2.0})))
        self.assertFalse(np.array_equal(blur_then_cut, cut_then_blur))  # the order matters at the edge of the cut

    def test_a_step_can_be_viewed_before_and_after(self) -> None:
        node = self.node()
        r = self.steps(node, [self.CROP, self.GAUSS])
        crop_id, filter_id = (s["id"] for s in r.json()["steps"])
        self.assertTrue(np.array_equal(self.picture(node, step=filter_id, stage="input"), self._cut(self.src)))
        self.assertTrue(np.array_equal(self.picture(node, step=filter_id, stage="output"), preprocess.apply(self._cut(self.src), "gaussian", {"sigma": 2.0})))
        self.assertTrue(np.array_equal(self.picture(node, step=crop_id, stage="input"), self.src))
        self.assertEqual(self.client.get(f"{self.base}/nodes/{node}/picture", params={"frame": self.names[0], "step": "zz"}).status_code, 422)

    def test_a_draft_previews_without_saving(self) -> None:
        node = self.node()
        draft = json.dumps([{"op": "filter", "name": "median", "params": {"size": 5}}])
        shown = self.picture(node, stage="output", steps=draft)
        self.assertTrue(np.array_equal(shown, preprocess.apply(self.src, "median", {"size": 5})))
        self.assertEqual(self.detail(node)["steps"], [{"id": "s1", "op": "crop", "rect": None}])  # nothing was saved
        bad = self.client.get(f"{self.base}/nodes/{node}/picture", params={"frame": self.names[0], "steps": "[{\"op\": \"spin\"}]"})
        self.assertEqual(bad.status_code, 422)

    def test_steps_are_checked(self) -> None:
        node = self.node()
        self.steps(node, [{"op": "filter", "name": "nope"}], 422)
        self.steps(node, [{"op": "filter", "name": "gaussian", "params": {"sigma": 99}}], 422)
        self.steps(node, [{"op": "filter", "name": "gaussian", "params": {"radius": 1}}], 422)
        self.steps(node, [{"op": "crop", "rect": [0.8, 0.8, 0.5, 0.5]}], 422)
        self.steps(node, [{"op": "blur"}], 422)
        self.steps(node, [self.GAUSS] * (flow.MAX_STEPS + 1), 422)
        r = self.client.put(f"{self.base}/nodes/{node}", json={"steps": "gaussian"})
        self.assertEqual(r.status_code, 422)
        done = self.steps(node, [{"op": "filter", "name": "gaussian"}]).json()["steps"]  # parameters are completed with the defaults
        self.assertEqual(done[0]["params"], {"sigma": 1.5})
        self.assertEqual(self.steps(node, []).json()["steps"], [])  # no step at all: the picture passes on

    def test_ids_are_kept_and_never_repeat(self) -> None:
        node = self.node()
        r = self.steps(node, [{"id": "a", **self.GAUSS}, {"id": "a", **self.CROP}, {"op": "crop", "rect": None}])
        ids = [s["id"] for s in r.json()["steps"]]
        self.assertEqual(ids[0], "a")
        self.assertEqual(len(set(ids)), 3)

    def test_a_detector_behind_the_box_goes_stale_when_a_step_or_the_order_changes(self) -> None:
        box, det = self.node(), self.node("detector")
        self.client.post(f"{self.base}/edges", json={"source": box, "target": det})
        sigs = []
        for steps in ([self.GAUSS, self.CROP], [self.CROP, self.GAUSS], [self.CROP, {**self.GAUSS, "params": {"sigma": 3.0}}], [self.CROP, self.GAUSS]):
            self.steps(box, steps)
            sigs.append(flow.signature(flow.load_graph(CAM), det))
        self.assertEqual(len(set(sigs[:3])), 3)
        self.assertEqual(sigs[1], sigs[3])  # the same steps, the same signature
        self.assertEqual(flow.input_rects(flow.load_graph(CAM), det)[0], RECT)

    def test_a_step_switched_off_keeps_its_place_and_is_skipped(self) -> None:
        node = self.node()
        r = self.steps(node, [self.GAUSS, {**self.CROP, "enabled": False}])
        stored = r.json()["steps"]
        self.assertEqual([s.get("enabled") for s in stored], [None, False])  # stored only when off
        self.assertTrue(np.array_equal(self.picture(node, stage="output"), preprocess.apply(self.src, "gaussian", {"sigma": 2.0})))
        self.assertEqual(len(self.detail(node)["steps"]), 2)  # still in the list, in the same place
        off_filter = self.steps(node, [{**self.GAUSS, "enabled": False}, self.CROP]).json()["steps"]
        self.assertTrue(np.array_equal(self.picture(node, stage="output"), self._cut(self.src)))
        self.assertIs(off_filter[0]["enabled"], False)
        back = self.steps(node, [{**s, "enabled": True} for s in off_filter]).json()["steps"]
        self.assertTrue(all("enabled" not in s for s in back))  # on again: stored as before
        self.assertTrue(np.array_equal(self.picture(node, stage="output"), self._cut(preprocess.apply(self.src, "gaussian", {"sigma": 2.0}))))

    def test_switching_a_step_off_or_on_changes_the_signature_of_a_detector_behind(self) -> None:
        box, det = self.node(), self.node("detector")
        self.client.post(f"{self.base}/edges", json={"source": box, "target": det})
        sigs = []
        for steps in ([self.GAUSS, self.CROP], [{**self.GAUSS, "enabled": False}, self.CROP], [self.GAUSS, self.CROP]):
            self.steps(box, steps)
            sigs.append(flow.signature(flow.load_graph(CAM), det))
        self.assertNotEqual(sigs[0], sigs[1])
        self.assertEqual(sigs[0], sigs[2])
        # a step that was never on or off before keeps the signature boxes made earlier had
        self.assertEqual(flow.clean_steps([self.GAUSS])[0].keys(), {"id", "op", "name", "params"})

    def test_the_chain_summary_tells_which_steps_are_off(self) -> None:
        node = self.node()
        self.steps(node, [self.GAUSS, {**self.CROP, "enabled": False}])
        summary = next(n for n in self.client.get(f"/api/cameras/{CAM}/chain").json()["nodes"] if n["id"] == node)["flow"]["steps"]
        self.assertEqual([s["enabled"] for s in summary], [True, False])

    def test_a_filter_does_not_move_anything(self) -> None:
        box, det = self.node(), self.node("detector")
        self.client.post(f"{self.base}/edges", json={"source": box, "target": det})
        self.steps(box, [self.GAUSS, self.CROP, {"op": "filter", "name": "median", "params": {"size": 3}}])
        graph = flow.load_graph(CAM)
        rects = flow.input_rects(graph, det)
        self.assertEqual(sum(flow.is_filter(r) for r in rects), 2)
        where = flow.rect_map(rects, 120, 80)
        self.assertEqual(where.point(0, 0), (30.0, 20.0))  # only the cut shifts
        self.assertEqual(flow.rect_offset(rects, 120, 80), (30, 20))
        image, ox, oy = flow.apply_rects(self.src, rects)
        self.assertEqual((ox, oy, image.shape[:2]), (30, 20, (40, 60)))

    def test_a_box_that_follows_a_target_keeps_its_crop_step(self) -> None:
        det = self.node("detector")
        self.client.post(f"{self.base}/nodes/{det}/targets", json={"name": "A"})
        box = self.node()
        r = self.client.post(f"{self.base}/edges", json={"source": det, "target": box, "point": "A"})
        self.assertEqual(r.status_code, 201, r.text)
        steps = self.detail(box)["steps"]
        self.assertEqual(self.detail(box)["follow_step"], steps[0]["id"])
        self.steps(box, [self.GAUSS, steps[0]])  # a filter ahead of it is fine: the crop step stays the one that follows
        self.assertEqual(self.detail(box)["follow_step"], steps[0]["id"])
        self.steps(box, [self.GAUSS], 422)  # the crop step cannot be taken out while the line is there
        r = self.client.put(f"{self.base}/nodes/{box}", json={"rect": RECT})
        self.assertEqual(r.status_code, 422)  # the rectangle of a following crop is drawn relative to the target

    def test_a_chain_of_grey_threshold_blobs_and_outline_runs_through_the_box(self) -> None:
        box = self.node()
        chain = [
            {"op": "filter", "name": "grey", "params": {}},
            {"op": "filter", "name": "threshold", "params": {"mode": "otsu", "objects": "dark"}},
            {"op": "filter", "name": "blobs", "params": {"count": 2, "min_size": 1.0}},
            {"op": "filter", "name": "outline", "params": {"mode": "ellipse_filled"}},
        ]
        self.steps(box, chain)
        out = self.picture(box, stage="output")
        self.assertEqual(out.shape[:2], self.src.shape[:2])
        self.assertTrue(set(np.unique(out)) <= {0, 255})
        self.steps(box, [{"op": "filter", "name": "threshold", "params": {"mode": "bogus"}}], status=422)

