from __future__ import annotations

import unittest

import classify
import classify_view as cv


def fs(frame, golden=None, **methods):
    return classify.FrameScore(
        frame=frame,
        golden=golden,
        per_method={
            m: classify.MethodScore(dists=d["dists"], leaning=d.get("leaning"), margin=d.get("margin"), novelty=d["novelty"])
            for m, d in methods.items()
        },
    )


A = fs("a.png", cpu={"dists": {"OK": 0.1, "NG": 0.5}, "leaning": "OK", "margin": 0.4, "novelty": 0.1})
B = fs("b.png", cpu={"dists": {"OK": 0.3, "NG": 0.31}, "leaning": "OK", "margin": 0.01, "novelty": 0.3})
C = fs("c.png", cpu={"dists": {"OK": 0.9, "NG": 0.2}, "leaning": "NG", "margin": 0.7, "novelty": 0.2})
G = fs("g.png", golden="OK")


class FilterSortTests(unittest.TestCase):
    def run_filter(self, view="All", order="Most novel first", **kw):
        args = dict(
            view=view, rank_method="cpu", order=order, scored=True, methods=["cpu"],
            lab={"a.png": "OK", "g.png": "OK"}, gold={"OK": ["g.png"]}, deleted=set(),
        )
        args.update(kw)
        return [r.frame for r in cv.filter_and_sort([A, B, C, G], **args)]

    def test_orders_put_goldens_last(self) -> None:
        self.assertEqual(self.run_filter(order="Most novel first"), ["b.png", "c.png", "a.png", "g.png"])
        self.assertEqual(self.run_filter(order="Most uncertain first"), ["b.png", "a.png", "c.png", "g.png"])
        self.assertEqual(self.run_filter(order="Name"), ["a.png", "b.png", "c.png", "g.png"])

    def test_unscored_sorts_by_name(self) -> None:
        self.assertEqual(self.run_filter(scored=False), ["a.png", "b.png", "c.png", "g.png"])

    def test_views(self) -> None:
        self.assertEqual(sorted(self.run_filter("Unlabeled")), ["b.png", "c.png"])
        self.assertEqual(sorted(self.run_filter("Labeled OK")), ["a.png", "g.png"])
        self.assertEqual(self.run_filter("Golden"), ["g.png"])
        self.assertEqual(self.run_filter("Methods disagree"), [])

    def test_deleted_is_hidden_except_in_deleted_view(self) -> None:
        self.assertNotIn("b.png", self.run_filter(deleted={"b.png"}))
        self.assertEqual(self.run_filter("Deleted", deleted={"b.png"}), ["b.png"])

    def test_methods_disagree(self) -> None:
        d = fs(
            "d.png",
            cpu={"dists": {"OK": 0.1, "NG": 0.2}, "leaning": "OK", "margin": 0.1, "novelty": 0.1},
            resnet50={"dists": {"OK": 0.3, "NG": 0.2}, "leaning": "NG", "margin": 0.1, "novelty": 0.2},
        )
        out = cv.filter_and_sort([A, d], view="Methods disagree", rank_method="cpu", order="Name", scored=True,
                                 methods=["cpu", "resnet50"], lab={}, gold={})
        self.assertEqual([r.frame for r in out], ["d.png"])


class BarsAndSelectionTests(unittest.TestCase):
    def test_bars_relative_closeness_and_close_call(self) -> None:
        b = cv.bars({"OK": 0.2, "NG": 0.4}, ["OK", "NG"])
        self.assertEqual([r["rel"] for r in b["rows"]], [1.0, 0.5])
        self.assertEqual([r["leader"] for r in b["rows"]], [True, False])
        self.assertFalse(b["close_call"])
        self.assertAlmostEqual(b["margin"], 0.2)
        self.assertTrue(cv.bars({"OK": 0.9, "NG": 1.0}, ["OK", "NG"])["close_call"])
        missing = cv.bars({"OK": 0.2, "NG": None}, ["OK", "NG"])
        self.assertEqual(missing["rows"][1]["rel"], 0.0)
        self.assertIsNone(missing["margin"])
        self.assertIsNone(cv.bars({"OK": None, "NG": None}, ["OK", "NG"]))

    def test_signatures_are_order_independent(self) -> None:
        self.assertEqual(cv.golden_signature({"OK": ["b", "a"], "NG": []}), cv.golden_signature({"NG": [], "OK": ["a", "b"]}))
        self.assertEqual(cv.frames_signature(["b", "a"]), cv.frames_signature(["a", "b"]))
        self.assertNotEqual(cv.frames_signature(["a"]), cv.frames_signature(["a", "b"]))

    def test_auto_candidates_exclude_labeled_goldens_and_unscored(self) -> None:
        cands = cv.auto_candidates([A, B, C, G], rank_method="cpu", lab={"a.png": "OK"}, gold={"OK": ["g.png"]})
        self.assertEqual([r.frame for r in cands], ["b.png", "c.png"])

    def test_auto_pick_margin_floor_and_classes(self) -> None:
        picks, lo, hi = cv.auto_pick([B, C], rank_method="cpu", classes=["OK", "NG"], min_margin=None)
        self.assertEqual({k: [r.frame for r in v] for k, v in picks.items()}, {"OK": ["b.png"], "NG": ["c.png"]})
        picks, *_ = cv.auto_pick([B, C], rank_method="cpu", classes=["OK", "NG"], min_margin=0.5)
        self.assertEqual({k: [r.frame for r in v] for k, v in picks.items()}, {"OK": [], "NG": ["c.png"]})
        picks, *_ = cv.auto_pick([B, C], rank_method="cpu", classes=["NG"], min_margin=None)
        self.assertEqual(list(picks), ["NG"])
        self.assertEqual(cv.auto_pick([], rank_method="cpu", classes=["OK"], min_margin=None)[0], {"OK": []})

    def test_bulk_modes(self) -> None:
        items = [A, B, C, G]
        picked, selectable, lo, hi, thr = cv.bulk_pick(items, rank_method="cpu", mode="leaning", lean_cls="OK", threshold=None)
        self.assertEqual((sorted(r.frame for r in picked), selectable, thr), (["a.png", "b.png"], 3, 0.01))
        picked, *_ = cv.bulk_pick(items, rank_method="cpu", mode="leaning", lean_cls="OK", threshold=0.2)
        self.assertEqual([r.frame for r in picked], ["a.png"])
        picked, *_ = cv.bulk_pick(items, rank_method="cpu", mode="ordinary", lean_cls=None, threshold=0.2)
        self.assertEqual(sorted(r.frame for r in picked), ["a.png", "c.png"])
        picked, *_ = cv.bulk_pick(items, rank_method="cpu", mode="uncertain", lean_cls=None, threshold=0.4)
        self.assertEqual(sorted(r.frame for r in picked), ["a.png", "b.png"])
        self.assertEqual(cv.bulk_pick([G], rank_method="cpu", mode="ordinary", lean_cls=None, threshold=None)[0], [])
        self.assertEqual(cv.bulk_pick(items, rank_method="cpu", mode="leaning", lean_cls="XX", threshold=None)[0], [])
