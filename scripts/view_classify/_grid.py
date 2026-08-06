"""Pagination controls and the per-card grid: thumb, badges/bars, buttons.

Rendering is split into ``_card`` (visual) and ``_buttons`` (label + star row)
so the two most likely to be edited stand alone rather than as part of a
100-line function.
"""
from __future__ import annotations

from contextvars import ContextVar
from functools import partial

import streamlit as st

import datamodel
import db
import engine
import labels
import perf
import ui_common

from . import _helpers


_PER_PAGE_OPTIONS = [12, 24, 48, 96]
_COLS_OPTIONS = [3, 4, 5, 6, 8]

# Ordinary app renders can use the state snapshots loaded by the parent. A
# later fragment-only rerun executes outside this context and refreshes only
# the affected frame with indexed point queries.
_FULL_GRID_RENDER: ContextVar[bool] = ContextVar("classify_full_grid_render", default=False)


def _load_grid_setting(camera: str, feature: str, kind: str, options: list[int], default: int) -> int:
    """Read a persisted grid setting for this ROI; fall back to default if unset/invalid."""
    raw = db.get_setting(camera, f"grid.{kind}.{feature}")
    try:
        val = int(raw) if raw is not None else default
    except (ValueError, TypeError):
        val = default
    return val if val in options else default


def _persist_if_changed(camera: str, feature: str, kind: str, value: int, session_key: str) -> None:
    """Write to SQLite only when the value actually differs from the last write."""
    marker = session_key + "::saved"
    if st.session_state.get(marker) != value:
        db.set_setting(camera, f"grid.{kind}.{feature}", str(value))
        st.session_state[marker] = value


def render_grid(
    items,
    *,
    camera: str,
    feature: str,
    classes: list[str],
    methods: list[str],
    rank_method: str,
    scored: bool,
    gold: dict[str, list[str]],
    lab: dict[str, str],
    deleted: set[str],
    cluster_snapshot: dict | None = None,
) -> None:
    """Two identical control rows (pagination 2/3 + settings 1/3) sandwich the grid."""
    page_key = f"page::{camera}::{feature}"
    st.session_state.setdefault(page_key, 1)

    # Shared source-of-truth keys for Per page / Columns (persisted per ROI).
    # Both the top and the bottom bars mirror this value; the widget keys used
    # by the actual selectboxes carry ::top / ::bottom suffixes so Streamlit
    # doesn't collide on identical keys.
    pp_shared = f"perpage::{camera}::{feature}"
    cols_shared = f"cols::{camera}::{feature}"
    st.session_state.setdefault(
        pp_shared, _load_grid_setting(camera, feature, "perpage", _PER_PAGE_OPTIONS, 24),
    )
    st.session_state.setdefault(
        cols_shared, _load_grid_setting(camera, feature, "cols", _COLS_OPTIONS, 4),
    )
    # Mirror shared value into each bar's widget key BEFORE the widgets render,
    # so both bars display the same number even after one of them changed on
    # the previous rerun.
    for pos in ("top", "bottom"):
        st.session_state[f"{pp_shared}::{pos}"] = st.session_state[pp_shared]
        st.session_state[f"{cols_shared}::{pos}"] = st.session_state[cols_shared]

    per_page = st.session_state[pp_shared]
    n_cols = st.session_state[cols_shared]
    n_pages = max(1, (len(items) + per_page - 1) // per_page)
    st.session_state[page_key] = min(st.session_state[page_key], n_pages)

    _control_row(camera, feature, page_key, n_pages, len(items), per_page, position="top")

    # --- card grid ---
    page = st.session_state[page_key]
    start = (page - 1) * per_page
    shown = items[start : start + per_page]
    roi_tuple = ui_common.roi_key(engine.resolve_roi(camera, feature))
    if per_page >= 48:
        st.caption(
            "Large page selected: initial thumbnail preparation and browser rendering "
            "will take longer. Use 24 per page for the most responsive labeling flow."
        )
    preparing = st.empty()
    preparing.caption(f"Preparing {len(shown)} grid cards and thumbnailsâ€¦")
    token = _FULL_GRID_RENDER.set(True)
    try:
        with perf.span("grid.presentation"):
            for row_start in range(0, len(shown), n_cols):
                row = shown[row_start : row_start + n_cols]
                columns = st.columns(n_cols)
                for col, fs in zip(columns, row):
                    # A hairline card keeps each frame's picture, scores, name and buttons
                    # reading as one unit instead of blurring into its neighbours.
                    with col, st.container(border=True):
                        _card(
                            fs, camera=camera, feature=feature, classes=classes,
                            methods=methods, rank_method=rank_method, scored=scored,
                            gold=gold, lab=lab, deleted=deleted, roi_tuple=roi_tuple,
                            cluster_snapshot=cluster_snapshot,
                        )
    finally:
        _FULL_GRID_RENDER.reset(token)
        preparing.empty()

    _control_row(camera, feature, page_key, n_pages, len(items), per_page, position="bottom")


def _sync_setting(camera: str, feature: str, kind: str, shared_key: str, position: str) -> None:
    """on_change callback: copy the changed widget's value into the shared key + DB."""
    val = st.session_state[f"{shared_key}::{position}"]
    st.session_state[shared_key] = val
    _persist_if_changed(camera, feature, kind, val, shared_key)


def _control_row(
    camera: str,
    feature: str,
    page_key: str,
    n_pages: int,
    n_items: int,
    per_page: int,
    *,
    position: str,
) -> None:
    """One row: First / Prev / status / Next / Last (2/3) + Per page / Columns (1/3).

    ``position`` is "top" or "bottom"; it disambiguates every widget key.
    Both bars share their Per page and Columns values via a pre-render mirror
    of the shared session-state key (see ``render_grid``).
    """
    page = st.session_state[page_key]
    start = (page - 1) * per_page
    shown_end = min(start + per_page, n_items)
    at_start = page <= 1
    at_end = page >= n_pages
    pp_shared = f"perpage::{camera}::{feature}"
    cols_shared = f"cols::{camera}::{feature}"

    (
        c_first, c_prev, c_mid, c_next, c_last,
        _gap,
        c_pp_lbl, c_pp, c_co_lbl, c_co,
    ) = st.columns([1.2, 1.2, 4, 1.2, 1.2, 0.4, 1.4, 1, 1.4, 1])

    if c_first.button(
        "« First", key=f"first::{camera}::{feature}::{position}", disabled=at_start
    ):
        st.session_state[page_key] = 1
        st.rerun()
    if c_prev.button(
        "‹ Prev", key=f"prev::{camera}::{feature}::{position}", disabled=at_start
    ):
        st.session_state[page_key] -= 1
        st.rerun()
    c_mid.markdown(
        f"<div style='text-align:center;padding-top:8px'>Page <b>{page}</b> of {n_pages}"
        f" &nbsp;·&nbsp; frames <b>{start + 1}–{shown_end}</b> of {n_items}</div>",
        unsafe_allow_html=True,
    )
    if c_next.button(
        "Next ›", key=f"next::{camera}::{feature}::{position}", disabled=at_end
    ):
        st.session_state[page_key] += 1
        st.rerun()
    if c_last.button(
        "Last »", key=f"last::{camera}::{feature}::{position}", disabled=at_end
    ):
        st.session_state[page_key] = n_pages
        st.rerun()

    c_pp_lbl.markdown(
        "<div style='padding-top:8px;text-align:right'>Per page</div>",
        unsafe_allow_html=True,
    )
    c_pp.selectbox(
        "Per page", _PER_PAGE_OPTIONS,
        key=f"{pp_shared}::{position}",
        label_visibility="collapsed",
        help="24 is recommended. Larger pages reduce pagination but take longer to prepare and render.",
        on_change=partial(_sync_setting, camera, feature, "perpage", pp_shared, position),
    )
    c_co_lbl.markdown(
        "<div style='padding-top:8px;text-align:right'>Columns</div>",
        unsafe_allow_html=True,
    )
    c_co.selectbox(
        "Columns", _COLS_OPTIONS,
        key=f"{cols_shared}::{position}",
        label_visibility="collapsed",
        help="More columns fit more pictures on screen; fewer make each cutout bigger.",
        on_change=partial(_sync_setting, camera, feature, "cols", cols_shared, position),
    )


_CLUSTER_PALETTE = [
    "#2a78d6", "#eb6834", "#1baf7a", "#c98500",
    "#d55181", "#4a3aa7", "#008300", "#e34948",
]


def _cluster_chip_html(entry) -> str:
    """Small color-coded chip. ``entry`` is (cluster_id, is_rep) or ``None``."""
    if entry is None:
        return ""
    cid, is_rep = entry
    if cid < 0:
        colour = "#6b7280"
        label = "unique"
    else:
        colour = _CLUSTER_PALETTE[cid % len(_CLUSTER_PALETTE)]
        label = f"cluster {cid}" + (" · rep" if is_rep else "")
    return (
        f"<div style='margin:-2px 0 4px;font-size:10px'>"
        f"<span style='background:{colour};color:#fff;padding:1px 5px;"
        f"border-radius:3px'>{label}</span></div>"
    )


def _card_state(camera, feature, frame, lab, gold, deleted):
    """Return ``(label, golden class, deleted)`` for one grid card.

    Full renders use parent snapshots. Fragment-only reruns use indexed point
    queries because the captured parent snapshots predate the card interaction.
    """
    if _FULL_GRID_RENDER.get():
        perf.count("grid.cards_using_bulk_state")
        return (
            lab.get(frame),
            labels.golden_class_of(gold, frame),
            frame in deleted,
        )
    perf.count("grid.cards_using_targeted_state")
    return (
        labels.current_label_for_frame(camera, feature, frame),
        labels.current_golden_for_frame(camera, feature, frame),
        db.is_frame_deleted(camera, frame),
    )


@st.fragment
def _card(
    fs, *, camera, feature, classes, methods, rank_method, scored, gold, lab, deleted,
    roi_tuple,
    cluster_snapshot: dict | None = None,
) -> None:
    """One card: thumbnail, scores or reference tag, filename+tag, button row.

    Wrapped in @st.fragment so a class or star click only reruns THIS card, not
    the whole page. The tradeoff: the metrics up top (per-class + ⭐ counts)
    stay at their pre-click values until the next full app rerun (any Refresh,
    pagination, or view change). That's a fair trade for click responsiveness
    on a 24-card grid.

    A full render uses the ``lab``, ``gold`` and ``deleted`` snapshots loaded by
    the parent. Fragment reruns query current state for this frame only, so the
    card reflects its latest write without replaying feature-wide histories.
    """
    perf.count("grid.cards_rendered")
    path = datamodel.unsorted_dir(camera) / fs.frame
    try:
        st.image(ui_common.cutout_thumb(str(path), roi_tuple, path.stat().st_mtime))
    except Exception as e:  # noqa: BLE001
        st.error(f"thumb error: {e}")

    # Reuse bulk state on a full render; point-query on a fragment rerun.
    labelled_now, golden_now, is_deleted = _card_state(
        camera, feature, fs.frame, lab, gold, deleted,
    )

    if golden_now:
        # A reference, not a candidate — nothing to score it against.
        colour = ui_common.class_color(golden_now, classes)
        st.markdown(
            f"<div style='margin:2px 0 6px;font-size:11px'>"
            f"<span style='background:{colour};color:#fff;padding:1px 5px;"
            f"border-radius:3px'>⭐ {golden_now}</span>"
            f"<span style='opacity:.6'> reference — not scored</span></div>",
            unsafe_allow_html=True,
        )
    elif scored:
        st.markdown(_helpers.leaning_html(fs, methods, classes), unsafe_allow_html=True)
        ms = fs.per_method.get(rank_method)
        if ms:
            # Bars carry the detail for the ranking method; the badges
            # above still show where the methods disagree.
            st.markdown(
                ui_common.class_bars_html(ms.dists, classes),
                unsafe_allow_html=True,
            )

    # A star always implies a label, so show one combined tag.
    if golden_now:
        tag = f"⭐**{golden_now}**"
    elif labelled_now:
        tag = f"**{labelled_now}**"
    else:
        tag = "—"
    st.caption(f"{fs.frame[:22]}  \n{tag}")

    if cluster_snapshot is not None:
        chip = _cluster_chip_html(cluster_snapshot.get(fs.frame))
        if chip:
            st.markdown(chip, unsafe_allow_html=True)

    _buttons(
        fs, camera=camera, feature=feature, classes=classes,
        labelled=labelled_now, golden_now=golden_now, is_deleted=is_deleted,
    )


def _buttons(fs, *, camera, feature, classes, labelled, golden_now, is_deleted) -> None:
    """One-row [class buttons] with a ★ that starts disabled until labelled,
    plus a trailing 🗑 / ↺ for camera-wide soft-delete.

    Clicking a different class moves the star with it, so a golden's class
    can never disagree with its label. The trash button toggles between
    delete and restore based on current state.

    Class + star click branches end in ``st.rerun()`` — inside the parent
    ``_card`` fragment this defaults to *fragment* scope so only the card
    re-executes. The delete/restore branch uses ``scope="app"`` because the
    delete filter lives in the outer render call, and we want the frame to
    actually disappear/reappear on click rather than just flip its icon.
    """
    # For 2 classes we honour the user's exact request "[OK] [★] [NG]";
    # for N>2 the star sits after the class buttons instead.
    # A trailing 🗑 / ↺ always sits at the far right.
    star_between = len(classes) == 2
    ncells = len(classes) + 2                              # +1 for star, +1 for trash
    row_cols = st.columns(ncells)
    star_idx = 1 if star_between else len(classes)
    trash_idx = ncells - 1
    cls_slots = [i for i in range(ncells) if i != star_idx and i != trash_idx]

    for slot, cls in zip(cls_slots, classes):
        on = labelled == cls
        if row_cols[slot].button(
            cls,
            key=f"lb::{feature}::{cls}::{fs.frame}",
            type="primary" if on else "secondary",
            help="Click again to remove the label." if on else None,
        ):
            if on:
                # Toggle off: a golden without a label would be inconsistent,
                # so drop the star along with the label.
                labels.clear_label(camera, feature, fs.frame)
                if golden_now == cls:
                    labels.unmark_golden(camera, feature, fs.frame, cls)
            else:
                labels.set_label(camera, feature, fs.frame, cls)
                # Star follows the label: keep the reference pointing at
                # whatever class the frame is now labelled.
                if golden_now and golden_now != cls:
                    labels.unmark_golden(camera, feature, fs.frame, golden_now)
                    labels.mark_golden(camera, feature, fs.frame, cls)
            st.rerun()

    star_on = golden_now is not None
    star_disabled = labelled is None
    # The gold ⭐ emoji renders self-coloured, so a lit star reads as
    # gold on any theme without needing per-button CSS (which cannot
    # distinguish this button from the primary class buttons above).
    if row_cols[star_idx].button(
        "⭐" if star_on else "☆",
        key=f"gd::{feature}::{fs.frame}",
        disabled=star_disabled,
        help=(
            "Label the frame first, then star it to make it a golden "
            "reference for that class."
            if star_disabled
            else (
                f"Currently a ⭐{golden_now} reference — click to remove."
                if star_on
                else f"Mark as a golden reference for {labelled}."
            )
        ),
    ):
        # Belt-and-suspenders: don't trust the `disabled=` alone. Streamlit can
        # fire a click captured just before the disabled flag flipped on, so
        # we always re-check that we actually have a class name to write.
        if star_on and golden_now:
            labels.unmark_golden(camera, feature, fs.frame, golden_now)
        elif not star_on and labelled:
            labels.mark_golden(camera, feature, fs.frame, labelled)
        st.rerun()

    if row_cols[trash_idx].button(
        "↺" if is_deleted else "🗑",
        key=f"del::{camera}::{fs.frame}",
        type="tertiary",
        help=(
            "Restore this frame — it comes back into view across every ROI on this camera."
            if is_deleted
            else "Soft-delete (camera-wide). The file stays on disk; switch **Show** to *Deleted* to see it again."
        ),
    ):
        if is_deleted:
            db.restore_frames(camera, [fs.frame])
        else:
            # Cascade: a deleted frame shouldn't count as a class example nor
            # influence scoring as a golden reference. Clear whatever state
            # this feature has for this frame before flipping the delete flag.
            # If the user restores, the frame comes back with a clean slate —
            # same as any freshly-ingested frame.
            if golden_now:
                labels.unmark_golden(camera, feature, fs.frame, golden_now)
            if labelled:
                labels.clear_label(camera, feature, fs.frame)
            h = labels.frame_hash(camera, fs.frame)
            db.mark_frames_deleted(camera, [(fs.frame, h)])
        # App-scope rerun: the deleted filter lives in the outer render call,
        # so the frame needs to actually leave / re-enter the current view —
        # not just flip its icon inside this fragment. It also refreshes the
        # top metrics so per-class + ⭐ counts reflect the cascade.
        st.rerun(scope="app")
