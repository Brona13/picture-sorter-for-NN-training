"""Presentation-neutral Classify logic: filtering/sorting, bars, bulk and auto selection.

Pure functions over ``classify.FrameScore`` lists, so the API (and tests) can drive
them without any UI framework.
"""
from __future__ import annotations

import labels

CLOSE_CALL_RATIO = 0.90
BASE_VIEWS = ["All", "Unlabeled", "Golden", "Methods disagree", "Deleted"]
ORDERS = ["Most novel first", "Most uncertain first", "Name"]
BULK_MODES = ["leaning", "ordinary", "uncertain"]


def valid_views(classes: list[str]) -> list[str]:
    return [*BASE_VIEWS[:2], *[f"Labeled {c}" for c in classes], *BASE_VIEWS[2:]]


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
    else:
        items.sort(key=lambda r: r.frame)
    return items


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
