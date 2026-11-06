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

    def test_worst_fit_first_puts_the_label_the_method_places_farthest_first(self) -> None:
        # a: label OK, nearest OK (100%); b: label NG, OK .3 vs NG .31 (97%); c: label OK, NG nearest, OK only 22%
        lab = {"a.png": "OK", "b.png": "NG", "c.png": "OK", "g.png": "OK"}
        self.assertEqual(self.run_filter(order=cv.WORST_FIT_ORDER, lab=lab), ["c.png", "b.png", "a.png", "g.png"])

    def test_worst_fit_first_the_lower_bar_of_the_label_comes_first(self) -> None:
        # the user's example: both NG, OK nearest at 100%; NG at 95% and at 85%, the 85% one first
        p1 = fs("p1.png", cpu={"dists": {"OK": 0.10, "NG": 0.10 / 0.95}, "novelty": 0.1})
        p2 = fs("p2.png", cpu={"dists": {"OK": 0.10, "NG": 0.10 / 0.85}, "novelty": 0.1})
        out = cv.filter_and_sort([p1, p2], view="All", rank_method="cpu", order=cv.WORST_FIT_ORDER, scored=True,
                                 methods=["cpu"], lab={"p1.png": "NG", "p2.png": "NG"}, gold={})
        self.assertEqual([r.frame for r in out], ["p2.png", "p1.png"])

    def test_worst_fit_first_ties_go_to_the_farthest_then_unlabeled_last(self) -> None:
        near = fs("near.png", cpu={"dists": {"OK": 0.1, "NG": 0.5}, "novelty": 0.1})
        far = fs("far.png", cpu={"dists": {"OK": 0.4, "NG": 0.9}, "novelty": 0.4})  # both agree (100%): the farther first
        free = fs("free.png", cpu={"dists": {"OK": 0.9, "NG": 0.1}, "novelty": 0.1})  # no label: after the labeled ones
        out = cv.filter_and_sort([free, near, far], view="All", rank_method="cpu", order=cv.WORST_FIT_ORDER, scored=True,
                                 methods=["cpu"], lab={"near.png": "OK", "far.png": "OK"}, gold={})
        self.assertEqual([r.frame for r in out], ["far.png", "near.png", "free.png"])

    def test_worst_fit_first_a_label_with_no_score_goes_last_and_a_zero_distance_is_100_percent(self) -> None:
        zero = fs("zero.png", cpu={"dists": {"OK": 0.0, "NG": 0.3}, "novelty": 0.0})
        gap = fs("gap.png", cpu={"dists": {"OK": 0.2, "NG": None}, "novelty": 0.2})  # labeled NG, no distance to NG
        out = cv.filter_and_sort([gap, zero], view="All", rank_method="cpu", order=cv.WORST_FIT_ORDER, scored=True,
                                 methods=["cpu"], lab={"zero.png": "OK", "gap.png": "NG"}, gold={})
        self.assertEqual([r.frame for r in out], ["zero.png", "gap.png"])

    def test_matrix_names_say_what_the_cell_means(self) -> None:
        name = lambda t, p: cv.matrix_view_name("resnet50", t, p, ["OK", "NG"])
        self.assertEqual(name("OK", "OK"), "R50 \u00b7 True positive (labeled OK, model says OK)")
        self.assertEqual(name("OK", "NG"), "R50 \u00b7 False negative (labeled OK, model says NG)")
        self.assertEqual(name("NG", "OK"), "R50 \u00b7 False positive (labeled NG, model says OK)")
        self.assertEqual(name("NG", "NG"), "R50 \u00b7 True negative (labeled NG, model says NG)")
        self.assertEqual(cv.matrix_view_name("cpu", "A", "B", ["A", "B", "C"]), "CPU \u00b7 A \u2192 leans B")
        self.assertEqual(cv.matrix_view_name("cpu", "OK", "NG", ["OK", "NG", "X"]), "CPU \u00b7 OK \u2192 leans NG")  # not a two-class pair

    def test_matrix_views_are_offered_per_method_and_only_when_asked(self) -> None:
        self.assertFalse([v for v in cv.valid_views(["OK", "NG"]) if "model says" in v])
        both = [v for v in cv.valid_views(["OK", "NG"], matrix_methods=["cpu", "resnet50"]) if "model says" in v]
        self.assertEqual(len(both), 8)
        self.assertEqual(cv.valid_views(["OK", "NG"], matrix_methods=["cpu"])[-1], "Deleted")
        self.assertEqual(cv.matrix_lookup(["OK"], ["cpu"]), {})  # one class: no matrix

    def test_a_matrix_view_lists_the_cells_pictures_without_goldens(self) -> None:
        cells = cv.matrix_lookup(["OK", "NG"], ["cpu"])
        lab = {"a.png": "OK", "b.png": "NG", "c.png": "OK", "g.png": "OK"}
        run = lambda t, p: [r.frame for r in cv.filter_and_sort(
            [A, B, C, G], view=cv.matrix_view_name("cpu", t, p, ["OK", "NG"]), rank_method="cpu", order="Name", scored=True,
            methods=["cpu"], lab=lab, gold={"OK": ["g.png"]}, matrix_cells=cells)]
        self.assertEqual(run("OK", "OK"), ["a.png"])  # a leans OK; g is a golden, so it is never counted
        self.assertEqual(run("NG", "OK"), ["b.png"])  # b is labeled NG, the method leans OK
        self.assertEqual(run("OK", "NG"), ["c.png"])  # c is labeled OK, the method leans NG
        self.assertEqual(run("NG", "NG"), [])

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

    def test_disagrees_with_label(self) -> None:
        d = fs("d.png", cpu={"dists": {"OK": 0.2, "NG": 0.1}, "leaning": "NG", "margin": 0.1, "novelty": 0.1})
        out = cv.filter_and_sort(
            [A, C, d, G], view=cv.DISAGREE_VIEW, rank_method="cpu", order="Name", scored=True, methods=["cpu"],
            lab={"a.png": "OK", "c.png": "OK", "d.png": "OK", "g.png": "OK"}, gold={"OK": ["g.png"]},
        )
        self.assertEqual([r.frame for r in out], ["c.png", "d.png"])  # labeled OK, a method leans NG; a.png agrees, g.png is a golden
        self.assertIn(cv.DISAGREE_VIEW, cv.valid_views(["OK", "NG"]))


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
