"""Filter/sort controls above the grid + the filter+sort logic itself.

The two functions here work in sequence: ``render_controls`` returns the user's
choices, ``filter_and_sort`` applies them to the current scored list. Kept in
one file because the sort tie-breaking mirrors the Order options.
"""
from __future__ import annotations

import streamlit as st

import labels


def render_controls(
    *, classes: list[str], methods: list[str], scored: bool, gold: dict[str, list[str]]
) -> tuple[str, str, str]:
    """Show/Rank/Order selectboxes and the two explanatory captions.

    Returns ``(view, rank_method, order)``.
    """
    f1, f2, f3 = st.columns([2, 2, 2])
    view = f1.selectbox(
        "Show",
        ["All", "Unlabeled", *[f"Labeled {c}" for c in classes], "Golden", "Methods disagree", "Deleted"],
    )
    # ResNet50 is the primary — the user's real-data test found the CPU family
    # is a useful *second opinion* (feeds the Methods disagree filter) but
    # not the ranking they'd trust by default.
    rank_default = methods.index("resnet50") if "resnet50" in methods else 0
    rank_method = f2.selectbox(
        "Rank using", methods, index=rank_default, disabled=not scored,
    )
    order = f3.selectbox(
        "Order by",
        ["Most novel first", "Most uncertain first", "Name"],
        disabled=not scored,
    )
    if not scored:
        st.caption(
            "ℹ️ *Rank using* and *Order by* are greyed out, and no scores appear under the "
            "pictures, because **nothing is scored yet** — scoring needs reference frames. "
            "Mark at least one **☆OK** (and ideally one **☆NG**) on a picture below, then "
            "press **🔄 Refresh scores**."
        )
    else:
        st.caption(
            f"Bars under each picture show how close that frame is to each class's ⭐goldens "
            f"under **{rank_method}** — longest bar = nearest class = the leaning. Near-equal "
            "bars (or **⚠ close call**) mean the machine can't separate them: those are the "
            "frames worth your eyes. They're a similarity advisory, not a probability."
        )
        have = [c for c in classes if gold.get(c)]
        if len(have) < 2:
            missing = [c for c in classes if not gold.get(c)]
            need = missing[0] if missing else "another class"
            st.caption(
                f"ℹ️ The leaning badges show “–” because only **{'/'.join(have) or 'none'}** "
                "has reference frames — a *leaning* needs at least two classes to compare. "
                f"Mark at least one **☆{need}** and refresh to get a per-method verdict. Until "
                "then **nov** still works: it ranks how unusual each frame is versus your "
                "current references (high = worth a look)."
            )
    return view, rank_method, order


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

    Goldens carry no scores (they're references), so every by-score ordering
    puts them last instead of blowing up on a missing method.

    Soft-deleted frames are hidden from every view except ``"Deleted"``, which
    surfaces only the deleted set — a symmetric filter with the same feel as
    the dedup mute checkbox above the grid.
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

    if scored:
        if order == "Most novel first":
            items.sort(key=lambda r: (_ms(r) is None, -(_ms(r).novelty if _ms(r) else 0.0)))
        elif order == "Most uncertain first":
            items.sort(
                key=lambda r: (
                    _ms(r) is None or _ms(r).margin is None,
                    _ms(r).margin if (_ms(r) and _ms(r).margin is not None) else 0.0,
                )
            )
        else:
            items.sort(key=lambda r: r.frame)
    else:
        items.sort(key=lambda r: r.frame)
    return items
