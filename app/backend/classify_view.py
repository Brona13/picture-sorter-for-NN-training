"""Presentation-neutral Classify logic: filtering/sorting, bars, bulk and auto selection.

Pure functions over ``classify.FrameScore`` lists, so the API (and tests) can drive
them without any UI framework.
"""
from __future__ import annotations

import insights
import labels
import methods_config

CLOSE_CALL_RATIO = 0.90
DISAGREE_VIEW = "Disagrees with label"  # a labeled picture that a method leans away from (what you assigned vs what the network sees)
BASE_VIEWS = ["All", "Unlabeled", "Golden", "Methods disagree", DISAGREE_VIEW, "Deleted"]
WORST_FIT_ORDER = "Worst fit first"  # the label's own class fits the picture worst, compared with the class the method finds nearest
ORDERS = ["Most novel first", "Most uncertain first", WORST_FIT_ORDER, "Name"]
BULK_MODES = ["leaning", "ordinary", "uncertain"]


EDGE_VIEW_PREFIX = "Edge angle: "
EDGE_VERDICTS = ["pass", "fail", "undetermined"]
EDGE_VIEWS = [f"{EDGE_VIEW_PREFIX}{v}" for v in EDGE_VERDICTS]


MEASURE_VIEW_PREFIX = "Measurement: "
MEASURE_VIEWS = [f"{MEASURE_VIEW_PREFIX}{v}" for v in EDGE_VERDICTS]


MATRIX_METHOD = "resnet50"  # the one method the confusion matrix and its Show entries are made for (several methods: later)
POSITIVE_CLASS = "OK"  # the class the confusion-matrix names are counted from: a labeled OK the method calls NG is a false negative
_BINARY_KIND = {
    ("OK", "OK"): "True positive",
    ("OK", "NG"): "False negative",
    ("NG", "NG"): "True negative",
    ("NG", "OK"): "False positive",
}


def matrix_view_name(method: str, true_c: str, pred_c: str, classes: list[str]) -> str:
    """The Show entry for one cell of one method's confusion matrix (rows = your label, columns = the method's leaning).
    OK / NG: ``R50 · False negative (labeled OK, model says NG)``; any other classes: ``R50 · A → leans B``."""
    tag = methods_config.INFO.get(method, {}).get("tag", method.upper())
    kind = _BINARY_KIND.get((true_c, pred_c)) if set(classes) == {"OK", "NG"} and len(classes) == 2 else None
    if kind:
        return f"{tag} · {kind} (labeled {true_c}, model says {pred_c})"
    return f"{tag} · {true_c} → leans {pred_c}"


def matrix_lookup(classes: list[str], methods: list[str]) -> dict[str, tuple[str, str, str]]:
    """Show entry -> (method, your label, the method's leaning), for every cell of every given method's matrix."""
    if len(classes) < 2:
        return {}
    return {matrix_view_name(m, t, p, classes): (m, t, p) for m in methods for t in classes for p in classes}


def valid_views(
    classes: list[str], *, edge_angle: bool = False, measurement: bool = False, matrix_methods: list[str] | None = None
) -> list[str]:
    """The Show filter choices; the edge-angle ones only exist while a rule with an expected angle has fresh
    results, the measurement ones while an Evaluation box on the chain is arrowed into this feature, and the
    confusion-matrix ones (one per cell and method, v1.159.0) for the methods named in ``matrix_methods``."""
    return [
        *BASE_VIEWS[:2], *[f"Labeled {c}" for c in classes], *BASE_VIEWS[2:-1],
        *(EDGE_VIEWS if edge_angle else []), *(MEASURE_VIEWS if measurement else []),
        *matrix_lookup(classes, matrix_methods or []), BASE_VIEWS[-1],
    ]


def golden_signature(gold: dict[str, list[str]]) -> str:
    """Stable fingerprint of the golden sets, to detect 'scores are stale'."""
    return "|".join(f"{cls}:{','.join(sorted(gold.get(cls, [])))}" for cls in sorted(gold))


def frames_signature(frames: list[str]) -> str:
    """Fingerprint of the frame set, to detect ingest/delete since last score."""
    return ",".join(sorted(frames))


def default_rank_method(methods: list[str]) -> str:
    # ResNet50 is the primary; the CPU family is a second opinion.
    return "resnet50" if "resnet50" in methods else methods[0]


def filter_and_sort(
    results,
    *,
    view: str,
    rank_method: str,
    order: str,
    scored: bool,
    methods: list[str],
    lab: dict[str, str],
    gold: dict[str, list[str]],
    deleted: set[str] | None = None,
    edge_verdicts: dict[str, str] | None = None,
    measure_verdicts: dict[str, str] | None = None,
    matrix_cells: dict[str, tuple[str, str, str]] | None = None,
) -> list:
    """Apply the Show filter + the Order sort.

    Goldens carry no scores (they're references), so every by-score ordering puts
    them last. Soft-deleted frames are hidden from every view except ``Deleted``.
    """

    def leanings(fs):
        return {fs.per_method[m].leaning for m in methods if m in fs.per_method}

    deleted = deleted or set()
    items = list(results)
    if view == "Deleted":
        items = [r for r in items if r.frame in deleted]
    else:
        items = [r for r in items if r.frame not in deleted]
        if view == "Unlabeled":
            items = [
                r for r in items
                if r.frame not in lab and labels.golden_class_of(gold, r.frame) is None
            ]
        elif view.startswith("Labeled "):
            want = view[len("Labeled "):]
            items = [r for r in items if lab.get(r.frame) == want]
        elif view == "Golden":
            items = [r for r in items if labels.golden_class_of(gold, r.frame)]
        elif view == "Methods disagree":
            items = [r for r in items if len(leanings(r) - {None}) > 1]
        elif view == DISAGREE_VIEW:
            items = [
                r for r in items
                if r.frame in lab and labels.golden_class_of(gold, r.frame) is None
                and any(l not in (None, lab[r.frame]) for l in leanings(r))
            ]
        elif matrix_cells and view in matrix_cells:
            # one cell of a confusion matrix: your label, not a golden, and where the method leans (the cell's own count)
            method, true_c, pred_c = matrix_cells[view]
            keep = set(insights.cell_frames(items, insights.evaluable_labels(lab, gold), method, true_c, pred_c))
            items = [r for r in items if r.frame in keep]
        elif view.startswith(EDGE_VIEW_PREFIX):
            want = view[len(EDGE_VIEW_PREFIX):]
            items = [r for r in items if (edge_verdicts or {}).get(r.frame) == want]
        elif view.startswith(MEASURE_VIEW_PREFIX):
            want = view[len(MEASURE_VIEW_PREFIX):]
            items = [r for r in items if (measure_verdicts or {}).get(r.frame) == want]

    def _ms(r):
        return r.per_method.get(rank_method)

    if scored and order == "Most novel first":
        items.sort(key=lambda r: (_ms(r) is None, -(_ms(r).novelty if _ms(r) else 0.0)))
    elif scored and order == "Most uncertain first":
        items.sort(
            key=lambda r: (
                _ms(r) is None or _ms(r).margin is None,
                _ms(r).margin if (_ms(r) and _ms(r).margin is not None) else 0.0,
            )
        )
    elif scored and order == WORST_FIT_ORDER:
        items.sort(key=lambda r: _worst_fit_key(r, _ms(r), lab, gold))
    else:
        items.sort(key=lambda r: r.frame)
    return items


def _worst_fit_key(r, ms, lab: dict[str, str], gold: dict[str, list[str]]) -> tuple:
    """Sort key of ``Worst fit first``: the bar of the picture's own label (``bars``: nearest distance / the label's
    distance), lowest first. The picture a method agrees with has 100% and comes late; one it places far from its label's
    goldens comes first. Among equal bars the one farthest from its label's goldens goes first, then the name. Pictures with
    no label, no score for that class, or that are goldens themselves (references, no scores) go last, by name."""
    cls = lab.get(r.frame)
    d = ms.dists.get(cls) if ms is not None and cls is not None else None
    if d is None or labels.golden_class_of(gold, r.frame) is not None:
        return (1, 0.0, 0.0, r.frame)
    d_min = min(v for v in ms.dists.values() if v is not None)
    rel = 1.0 if d <= 0 else d_min / d
    return (0, rel, -d, r.frame)


def clear_pick(
    items, *, lab: dict[str, str], gold: dict[str, list[str]], include_goldens: bool
) -> tuple[list[str], int]:
    """Frames of ``items`` whose label would be cleared, and how many goldens were spared.

    Unlabeled frames have nothing to clear. Goldens are trusted references, so they are
    left alone unless ``include_goldens`` is set (clearing a golden's label drops the mark).
    """
    picked: list[str] = []
    spared = 0
    for r in items:
        is_golden = labels.golden_class_of(gold, r.frame) is not None
        if r.frame not in lab and not is_golden:
            continue
        if is_golden and not include_goldens:
            spared += 1
            continue
        picked.append(r.frame)
    return picked, spared


def bars(dists: dict[str, float | None], classes: list[str]) -> dict | None:
    """Per-class relative closeness for one frame under one method.

    ``rel`` = nearest distance / this class's distance (nearest class -> 1.0). A
    similarity advisory, not a probability. ``close_call`` flags a runner-up within
    ``CLOSE_CALL_RATIO`` of the leader.
    """
    present = [d for d in dists.values() if d is not None]
    if not present:
        return None
    ranked = sorted(present)
    d_min = ranked[0]
    margin = (ranked[1] - ranked[0]) if len(ranked) >= 2 else None
    leader = min(
        (c for c in classes if dists.get(c) is not None), key=lambda c: dists[c], default=None
    )
    close = len(ranked) >= 2 and ranked[1] > 0 and (d_min / ranked[1]) >= CLOSE_CALL_RATIO
    rows = []
    for cls in classes:
        d = dists.get(cls)
        rel = 0.0 if d is None else (1.0 if d <= 0 else d_min / d)
        rows.append({"cls": cls, "dist": d, "rel": rel, "leader": cls == leader})
    return {"rows": rows, "novelty": d_min, "margin": margin, "close_call": close}


# --- auto-assign -------------------------------------------------------------
def auto_candidates(items, *, rank_method: str, lab: dict[str, str], gold: dict[str, list[str]]):
    """Unlabelled, non-golden frames that have a leaning and a margin under ``rank_method``."""
    golden_frames = {f for frames in gold.values() for f in frames}
    return [
        r for r in items
        if r.frame not in lab
        and r.frame not in golden_frames
        and rank_method in r.per_method
        and r.per_method[rank_method].leaning is not None
        and r.per_method[rank_method].margin is not None
    ]


def margin_bounds(values: list[float]) -> tuple[float, float]:
    lo, hi = float(min(values)), float(max(values))
    return lo, (hi if hi > lo else lo + 1e-6)


def auto_pick(candidates, *, rank_method: str, classes: list[str], min_margin: float | None):
    """``{class: [FrameScore]}`` of candidates leaning that class with margin >= floor."""
    if not candidates:
        return {c: [] for c in classes}, 0.0, 0.0
    lo, hi = margin_bounds([r.per_method[rank_method].margin for r in candidates])
    floor = lo if min_margin is None else min_margin
    by_class: dict[str, list] = {c: [] for c in classes}
    for r in candidates:
        ms = r.per_method[rank_method]
        if ms.leaning in by_class and ms.margin >= floor:
            by_class[ms.leaning].append(r)
    return by_class, lo, hi


# --- bulk selection ----------------------------------------------------------
def bulk_pick(items, *, rank_method: str, mode: str, lean_cls: str | None, threshold: float | None):
    """Select scored frames by leaning/margin, or by novelty/margin ceiling.

    Returns ``(picked, selectable_count, lo, hi, effective_threshold)``.
    """
    selectable = [r for r in items if rank_method in r.per_method]
    if mode == "leaning":
        cand = [
            r for r in selectable
            if r.per_method[rank_method].leaning == lean_cls
            and r.per_method[rank_method].margin is not None
        ]
        if not cand:
            return [], len(selectable), 0.0, 0.0, 0.0
        lo, hi = margin_bounds([r.per_method[rank_method].margin for r in cand])
        thr = lo if threshold is None else threshold
        return [r for r in cand if r.per_method[rank_method].margin >= thr], len(selectable), lo, hi, thr
    if not selectable:
        return [], 0, 0.0, 0.0, 0.0
    use_margin = mode == "uncertain"
    vals = [
        ((r.per_method[rank_method].margin if use_margin else r.per_method[rank_method].novelty) or 0.0)
        for r in selectable
    ]
    lo, hi = margin_bounds(vals)
    thr = lo if threshold is None else threshold
    return [r for r, v in zip(selectable, vals) if v <= thr], len(selectable), lo, hi, thr
