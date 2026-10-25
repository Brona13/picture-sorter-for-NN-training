"""Classify: scored grid, label/golden/delete actions, refresh job, bulk and auto-assign."""
from __future__ import annotations

import grid_sizes
import dataclasses
import hashlib
from typing import Annotated

import classify
import classify_view as cv
import datamodel
import db
import dedup
import edge_angle
import flow
import embedding
import engine
import labels
import suggest_goldens as suggest_goldens_mod
from api import dedup_api, jobs
from api.cameras import require_feature
from api.frames_api import frame_path
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
import applog

_log = applog.get("classify_api")

router = APIRouter()
PER_PAGE_OPTIONS = grid_sizes.all_per_page()  # alone (no column count): any size that is valid for some column count
COLS_OPTIONS = list(grid_sizes.COLS)


class GridQuery(BaseModel):
    """What the user is looking at: feature + Show / Rank / Order + toggles."""

    feature: str
    view: str = "All"
    rank: str | None = None
    order: str = "Most novel first"
    show_muted: bool = False
    # Optional grid filter: only the frames auto-assign would label right now.
    auto_preview: bool = False
    auto_classes: list[str] | None = None
    auto_min_margin: float | None = None
    # A part of a file name: the grid then lists every picture of the camera that matches (see ``_search_grid``).
    search: str = ""


def _grid_query(
    feature: str,
    view: str = "All",
    rank: str | None = None,
    order: str = "Most novel first",
    show_muted: bool = False,
    auto_preview: bool = False,
    auto_classes: Annotated[list[str] | None, Query()] = None,
    auto_min_margin: float | None = None,
    search: str = "",
) -> GridQuery:
    return GridQuery(
        feature=feature, view=view, rank=rank, order=order, show_muted=show_muted,
        auto_preview=auto_preview, auto_classes=auto_classes, auto_min_margin=auto_min_margin, search=search,
    )


QueryParams = Annotated[GridQuery, Depends(_grid_query)]


# --- results (persisted by Refresh) -----------------------------------------
_deserialised: dict[tuple[str, str], tuple[str, list]] = {}


def _roi_key(camera: str, feature: str) -> str:
    return classify._roi_cache_key(engine.resolve_roi(camera, feature), camera, feature)


def load_scored(camera: str, feature: str) -> tuple[list | None, str | None, str | None]:
    """``(results, golden_sig, frames_sig)`` from the persistent cache, or ``(None, None, None)``.

    Decoding thousands of scored frames per request would dominate grid latency, so
    the decoded list is memoised per feature, keyed by a digest of the stored payload.
    """
    row = db.load_results(camera, feature, _roi_key(camera, feature))
    if row is None:
        return None, None, None
    methods = classify.methods_available()
    digest = hashlib.blake2b(row["payload"], digest_size=16).hexdigest() + "|" + ",".join(methods)
    cached = _deserialised.get((camera, feature))
    if cached and cached[0] == digest:
        return cached[1], row["golden_sig"], row["frames_sig"]
    try:
        results = classify.deserialise_results(row["payload"], methods)
    except Exception:  # noqa: BLE001 - a malformed row must not wedge the view
        applog.warn_once(_log, f"score-cache-{camera}-{feature}", "unreadable score cache for %s/%s, it is recomputed", camera, feature)
        return None, None, None
    _deserialised[(camera, feature)] = (digest, results)
    return results, row["golden_sig"], row["frames_sig"]


# --- edge-angle rule results -------------------------------------------------
def _edge_state(camera: str, feature: str) -> dict:
    """Fresh edge-angle measurements by frame name plus verdicts ({} when the rule has not been run
    on the current settings). Verdicts exist only when an expected angle is set."""
    settings = edge_angle.get(camera, feature)
    if settings is None or edge_angle.results_status(camera, feature) != "fresh":
        return {"measured": {}, "verdicts": {}}
    results = edge_angle.load_results(camera, feature)
    hmap = labels.hash_map(camera)
    measured, verdicts = {}, {}
    for frame, h in hmap.items():
        r = results.get(h)
        if r is None:
            continue
        measured[frame] = r
        v = edge_angle.verdict(r, settings["expected"])
        if v:
            verdicts[frame] = v
    return {"measured": measured, "verdicts": verdicts}


def _measure_state(camera: str, feature: str) -> dict:
    """What the Evaluation boxes arrowed into this feature's Classify box say, by frame name: one verdict per
    frame (a fail beats undetermined, which beats pass) and every box's measured value."""
    boxes = flow.feature_opinions(camera, feature)["boxes"]
    verdicts: dict[str, str] = {}
    values: dict[str, list[dict]] = {}
    rank = {"pass": 0, "undetermined": 1, "fail": 2}
    for b in boxes:
        for frame, v in b["verdicts"].items():
            if frame not in verdicts or rank[v] > rank[verdicts[frame]]:
                verdicts[frame] = v
            values.setdefault(frame, []).append({"value": b["values"].get(frame), "unit": b["unit"], "nominal": b["nominal"], "tolerance": b["tolerance"], "mode": b["mode"], "zone": b["zone"], "point": b["deviations"].get(frame) or b["points"].get(frame), "relative": bool(b["zone"] and b["zone"]["center"]), "verdict": v})
    return {"verdicts": verdicts, "values": values}


# --- shared context ----------------------------------------------------------
@dataclasses.dataclass
class Ctx:
    camera: str
    feature: str
    classes: list[str]
    methods: list[str]
    rank: str
    results: list | None
    gold: dict
    lab: dict
    deleted: set
    scored: bool
    items: list
    edge: dict
    measure: dict = dataclasses.field(default_factory=lambda: {"verdicts": {}, "values": {}})


def _build(camera: str, q: GridQuery, *, apply_auto_preview: bool = True) -> Ctx:
    require_feature(camera, q.feature)
    classes = datamodel.classes_for(camera, q.feature)
    methods = classify.methods_available()
    rank = q.rank or cv.default_rank_method(methods)
    if rank not in methods:
        raise HTTPException(status_code=422, detail=f"Unknown rank method: {rank}")
    edge = _edge_state(camera, q.feature)
    measure = _measure_state(camera, q.feature)
    if q.view not in cv.valid_views(classes, edge_angle=bool(edge["verdicts"]), measurement=bool(measure["verdicts"])):
        raise HTTPException(status_code=422, detail=f"Unknown view: {q.view}")
    if q.order not in cv.ORDERS:
        raise HTTPException(status_code=422, detail=f"Unknown order: {q.order}")
    gold = labels.current_goldens(camera, q.feature)
    lab = labels.current_labels(camera, q.feature)
    deleted = db.deleted_frames_of(camera)
    results, _, _ = load_scored(camera, q.feature)
    scored = bool(results) and any(r.per_method for r in results)
    visible = results or []
    if not q.show_muted:
        muted = db.muted_frames(camera, q.feature)
        if muted:
            visible = [r for r in visible if r.frame not in muted]
    items = cv.filter_and_sort(
        visible, view=q.view, rank_method=rank, order=q.order, scored=scored,
        methods=methods, lab=lab, gold=gold, deleted=deleted, edge_verdicts=edge["verdicts"],
        measure_verdicts=measure["verdicts"],
    )
    ctx = Ctx(camera, q.feature, classes, methods, rank, results, gold, lab, deleted, scored, items, edge, measure)
    if apply_auto_preview and q.auto_preview and scored:
        picks = _auto_picks(ctx, q.auto_classes, q.auto_min_margin)[0]
        keep = {r.frame for rs in picks.values() for r in rs}
        ctx.items = [r for r in ctx.items if r.frame in keep]
    return ctx


def _auto_picks(ctx: Ctx, classes: list[str] | None, min_margin: float | None):
    chosen = ctx.classes if classes is None else [c for c in classes if c in ctx.classes]
    cands = cv.auto_candidates(ctx.items, rank_method=ctx.rank, lab=ctx.lab, gold=ctx.gold)
    picks, lo, hi = cv.auto_pick(cands, rank_method=ctx.rank, classes=chosen, min_margin=min_margin)
    return picks, len(cands), lo, hi


# --- settings ---------------------------------------------------------------
def _grid_setting(camera: str, feature: str, kind: str, options: list[int], default: int) -> int:
    raw = db.get_setting(camera, f"grid.{kind}.{feature}")
    try:
        value = int(raw) if raw is not None else default
    except (TypeError, ValueError):
        value = default
    return value if value in options else default


class GridSettings(BaseModel):
    feature: str
    per_page: int
    cols: int


@router.put("/cameras/{camera}/classify/grid-settings")
def set_grid_settings(camera: str, body: GridSettings) -> dict:
    require_feature(camera, body.feature)
    if not grid_sizes.is_valid(body.per_page, body.cols):
        raise HTTPException(status_code=422, detail="Unsupported per_page or cols value.")
    db.set_setting(camera, f"grid.perpage.{body.feature}", str(body.per_page))
    db.set_setting(camera, f"grid.cols.{body.feature}", str(body.cols))
    return {"per_page": body.per_page, "cols": body.cols}


def _counts(camera: str, feature: str, **state) -> dict[str, int]:
    """The numbers above the grid: only the pictures the user works with (not deleted, not muted for this ROI)."""
    hidden = db.deleted_frames_of(camera) | db.muted_frames(camera, feature)
    return labels.live_counts(camera, feature, hidden=hidden, **state)


# --- overview ----------------------------------------------------------------
@router.get("/cameras/{camera}/classify/state")
def state(camera: str, feature: str) -> dict:
    require_feature(camera, feature)
    classes = datamodel.classes_for(camera, feature)
    methods = classify.methods_available()
    gold = labels.current_goldens(camera, feature)
    lab = labels.current_labels(camera, feature)
    counts = _counts(camera, feature, label_state=lab, golden_state=gold)
    results, gsig, fsig = load_scored(camera, feature)
    frames = datamodel.frames_for_feature(camera, feature)
    inbox = len(datamodel.list_unsorted(camera))
    return {
        "feature": feature,
        "classes": classes,
        "counts": counts,
        "methods": methods,
        "default_rank": cv.default_rank_method(methods),
        "device": embedding.active_device(),
        "device_label": embedding.device_label(),
        "views": cv.valid_views(
            classes, edge_angle=bool(_edge_state(camera, feature)["verdicts"]),
            measurement=bool(_measure_state(camera, feature)["verdicts"]),
        ),
        "orders": cv.ORDERS,
        "has_results": results is not None,
        "scored": bool(results) and any(r.per_method for r in results),
        "cold_start": not any(gold.get(c) for c in classes),
        "stale": {
            "goldens": results is not None and gsig != cv.golden_signature(gold),
            "frames": results is not None and fsig != cv.frames_signature(frames),
        },
        # methods switched on (Configuration) since the last refresh: they have no scores yet
        "missing_methods": classify.missing_methods(results, methods) if results else [],
        "muted_count": len(db.muted_frames(camera, feature)),
        "shared_products": datamodel.feature_products(camera, feature),
        "frames_seen": len(frames),
        "inbox_total": inbox,
        # For "Frames 120 of 180": whether the ROI covers only some products, and how many pictures the camera has left.
        "scope": {
            "restricted": bool(datamodel.split_feature(feature)[0] or datamodel.feature_products(camera, feature)),
            "camera_frames": inbox - len(db.deleted_frames_of(camera)),
        },
        "settings": {
            "per_page": _grid_setting(camera, feature, "perpage", PER_PAGE_OPTIONS, 24),
            "cols": _grid_setting(camera, feature, "cols", COLS_OPTIONS, 4),
            "per_page_options": grid_sizes.per_page_options(_grid_setting(camera, feature, "cols", COLS_OPTIONS, 4)),
            "cols_options": COLS_OPTIONS,
        },
    }


# --- refresh job -------------------------------------------------------------
class FeatureBody(BaseModel):
    feature: str


@router.post("/cameras/{camera}/classify/refresh", status_code=202)
def refresh(camera: str, body: FeatureBody) -> dict:
    require_feature(camera, body.feature)
    feature = body.feature

    def work(report):
        gold = labels.current_goldens(camera, feature)
        results = classify.refresh(
            camera, feature, phase_progress_cb=lambda u: report(dataclasses.asdict(u))
        )
        report({"phase": "persistence", "done": 0, "total": 1})
        gsig = cv.golden_signature(gold)
        fsig = cv.frames_signature(datamodel.frames_for_feature(camera, feature))
        db.save_results(camera, feature, _roi_key(camera, feature), gsig, fsig,
                        classify.serialise_results(results))
        report({"phase": "persistence", "done": 1, "total": 1})
        return {"frames": len(results), "scored": any(r.per_method for r in results)}

    return jobs.registry.submit("classify_refresh", camera, work, feature=feature).to_dict()


# --- grid --------------------------------------------------------------------
def _card(camera: str, feature: str, frame: str, classes: list[str]) -> dict:
    return {
        "frame": frame,
        "label": labels.current_label_for_frame(camera, feature, frame),
        "golden": labels.current_golden_for_frame(camera, feature, frame),
        "deleted": db.is_frame_deleted(camera, frame),
    }


def _edge_card(edge: dict, frame: str) -> dict | None:
    r = edge["measured"].get(frame)
    if r is None:
        return None
    return {"verdict": edge["verdicts"].get(frame), "status": r["status"], "angle": r["angle"], "polarity": r["polarity"]}


def _grid_card(ctx: Ctx, fs, snapshot: dict | None) -> dict:
    """The card of one scored frame, as the grid shows it."""
    golden = labels.golden_class_of(ctx.gold, fs.frame)
    ms = fs.per_method.get(ctx.rank)
    chip = snapshot.get(fs.frame) if snapshot else None
    return {
        "frame": fs.frame,
        "label": ctx.lab.get(fs.frame),
        "golden": golden,
        "deleted": fs.frame in ctx.deleted,
        "leanings": {m: p.leaning for m, p in fs.per_method.items()},
        "bars": None if golden or not ms else cv.bars(ms.dists, ctx.classes),
        "cluster": {"id": chip[0], "is_rep": chip[1]} if chip else None,
        "edge": _edge_card(ctx.edge, fs.frame),
        "measure": ctx.measure["values"].get(fs.frame),
    }


def _page(total: int, page: int, per_page: int) -> tuple[int, int]:
    n_pages = max(1, (total + per_page - 1) // per_page)
    return n_pages, max(1, min(page, n_pages))


def _search_grid(camera: str, q: GridQuery, page: int, per_page: int) -> dict:
    """Every picture of the camera whose file name contains the search text, in name order.

    It ignores the View, the muted and the auto-preview filters: the point is to find one picture wherever it is,
    deleted, muted or outside this ROI's scope included. Cards look like the grid's own; each also says whether the
    picture is outside this ROI's scope (``outside``), which product it is in (``product``) and whether it is muted
    for this ROI (``muted``), so the page can flag it and offer the fixes.
    """
    require_feature(camera, q.feature)
    classes = datamodel.classes_for(camera, q.feature)
    methods = classify.methods_available()
    rank = q.rank or cv.default_rank_method(methods)
    if rank not in methods:
        raise HTTPException(status_code=422, detail=f"Unknown rank method: {rank}")
    needle = q.search.strip().lower()
    matches = [p.name for p in datamodel.list_unsorted(camera) if needle in p.name.lower()]
    total = len(matches)
    n_pages, page = _page(total, page, per_page)
    shown = matches[(page - 1) * per_page : page * per_page]

    results, _, _ = load_scored(camera, q.feature)
    scored_by_frame = {r.frame: r for r in results or []}
    ctx = Ctx(
        camera, q.feature, classes, methods, rank, results, labels.current_goldens(camera, q.feature),
        labels.current_labels(camera, q.feature), db.deleted_frames_of(camera),
        bool(results) and any(r.per_method for r in results), [], _edge_state(camera, q.feature),
        _measure_state(camera, q.feature),
    )
    snapshot = dedup.load_snapshot(camera, q.feature)
    in_scope = set(datamodel.frames_for_feature(camera, q.feature))
    muted = db.muted_frames(camera, q.feature)
    product_feature = datamodel.classify_feature(camera)
    product_of = labels.current_labels(camera, product_feature) if product_feature else {}
    cards = []
    for frame in shown:
        fs = scored_by_frame.get(frame) or classify.FrameScore(frame=frame, golden=None)
        card = _grid_card(ctx, fs, snapshot)
        card["muted"] = frame in muted
        card["product"] = product_of.get(frame)
        # A deleted picture has lost its labels, so its product is unknown: it is flagged by being deleted, not as outside.
        card["outside"] = frame not in in_scope and frame not in ctx.deleted
        cards.append(card)
    return {
        "has_results": results is not None,
        "scored": ctx.scored,
        "rank": rank,
        "page": page,
        "per_page": per_page,
        "n_pages": n_pages,
        "total": total,
        "items": cards,
        "search": {
            "query": q.search.strip(),
            "classify_feature": product_feature,
            "product_classes": datamodel.classes_for(camera, product_feature) if product_feature else [],
        },
    }


@router.get("/cameras/{camera}/classify/grid")
def grid(camera: str, q: QueryParams, page: int = 1, per_page: int | None = None) -> dict:
    if per_page is None:
        per_page = _grid_setting(camera, q.feature, "perpage", PER_PAGE_OPTIONS, 24)
    if per_page not in PER_PAGE_OPTIONS:
        raise HTTPException(status_code=422, detail="Unsupported per_page value.")
    if q.search.strip():
        return _search_grid(camera, q, page, per_page)
    ctx = _build(camera, q)
    total = len(ctx.items)
    n_pages, page = _page(total, page, per_page)
    shown = ctx.items[(page - 1) * per_page : page * per_page]
    snapshot = dedup.load_snapshot(camera, q.feature)
    return {
        "has_results": ctx.results is not None,
        "scored": ctx.scored,
        "rank": ctx.rank,
        "page": page,
        "per_page": per_page,
        "n_pages": n_pages,
        "total": total,
        "items": [_grid_card(ctx, fs, snapshot) for fs in shown],
    }


# --- per-card actions --------------------------------------------------------
class LabelBody(BaseModel):
    feature: str
    frame: str
    cls: str | None = None  # null clears the label (and any golden)
    via: str | None = None  # the tool the label was set from (Scatter, Outliers, ...); Classify when omitted


class GoldenBody(BaseModel):
    feature: str
    frame: str
    golden: bool


class DeleteBody(BaseModel):
    feature: str
    frame: str
    note: str = ""
    via: str | None = None  # the tool the delete was made from; stored as the deletion's source


def _result(camera: str, feature: str, frame: str, classes: list[str]) -> dict:
    return {
        "card": _card(camera, feature, frame, classes),
        "counts": _counts(camera, feature),
    }


@router.put("/cameras/{camera}/classify/label")
def set_label(camera: str, body: LabelBody) -> dict:
    require_feature(camera, body.feature)
    frame_path(camera, body.frame)
    classes = datamodel.classes_for(camera, body.feature)
    if body.cls is None:
        labels.clear_label(camera, body.feature, body.frame)  # also drops the golden
    elif body.cls not in classes:
        raise HTTPException(status_code=422, detail=f"Unknown class: {body.cls}")
    else:
        labels.set_label(camera, body.feature, body.frame, body.cls, via=body.via)  # a golden follows the label
    return _result(camera, body.feature, body.frame, classes)


@router.put("/cameras/{camera}/classify/golden")
def set_golden(camera: str, body: GoldenBody) -> dict:
    require_feature(camera, body.feature)
    frame_path(camera, body.frame)
    classes = datamodel.classes_for(camera, body.feature)
    label = labels.current_label_for_frame(camera, body.feature, body.frame)
    golden = labels.current_golden_for_frame(camera, body.feature, body.frame)
    if body.golden:
        if label is None:
            raise HTTPException(status_code=409, detail="Label the frame before making it a golden.")
        if golden is None:
            labels.mark_golden(camera, body.feature, body.frame, label)
    elif golden is not None:
        labels.unmark_golden(camera, body.feature, body.frame, golden)
    return _result(camera, body.feature, body.frame, classes)


MAX_NOTE = 200


def _clean_via(via: str | None) -> str:
    """The tool a delete came from, kept as the deletion's source; ``user`` (the default) when it is not named."""
    return " ".join((via or "").split())[:40] or "user"


def _clean_note(note: str) -> str:
    return " ".join(note.split())[:MAX_NOTE]


def _delete_frames(camera: str, frames: list[str], note: str, via: str | None = None) -> dict:
    """Soft-delete (camera-wide). Clears the frames' labels and goldens in every feature of
    the camera first, so a deleted frame can't act as a reference; a restored frame comes
    back with a clean slate. The dedup clustering held in memory drops them too."""
    for frame in frames:
        frame_path(camera, frame)
    hmap = labels.hash_map(camera)
    features = datamodel.list_features(camera)
    cleared_labels = cleared_goldens = 0
    for feat in features:
        gold = labels.current_goldens(camera, feat)
        on_gold = {f for fs in gold.values() for f in fs}
        lab = labels.current_labels(camera, feat)
        cleared_goldens += sum(1 for f in frames if f in on_gold)
        cleared_labels += sum(1 for f in frames if f in lab)
        labels.clear_labels_bulk(camera, feat, [f for f in frames if f in lab or f in on_gold])
    db.mark_frames_deleted(
        camera, [(f, labels.frame_hash(camera, f, hmap)) for f in frames], source=_clean_via(via), note=_clean_note(note)
    )
    dedup_api.drop_deleted(camera, frames)
    return {"deleted": len(frames), "cleared_labels": cleared_labels, "cleared_goldens": cleared_goldens}


@router.post("/cameras/{camera}/classify/delete")
def delete_frame(camera: str, body: DeleteBody) -> dict:
    require_feature(camera, body.feature)
    classes = datamodel.classes_for(camera, body.feature)
    _delete_frames(camera, [body.frame], body.note, body.via)
    return _result(camera, body.feature, body.frame, classes)


@router.post("/cameras/{camera}/classify/restore")
def restore_frame(camera: str, body: DeleteBody) -> dict:
    require_feature(camera, body.feature)
    frame_path(camera, body.frame)
    classes = datamodel.classes_for(camera, body.feature)
    db.restore_frames(camera, [body.frame])
    return _result(camera, body.feature, body.frame, classes)


class UnmuteBody(BaseModel):
    feature: str
    frame: str


@router.post("/cameras/{camera}/classify/unmute")
def unmute_frame(camera: str, body: UnmuteBody) -> dict:
    """Bring a picture hidden by the duplicate step (a dedup mute) back into this ROI's grid. Nothing happens if it was not muted."""
    require_feature(camera, body.feature)
    frame_path(camera, body.frame)
    db.unmute_frames(camera, body.feature, [body.frame])
    return {"frame": body.frame, "muted": False, "muted_count": len(db.muted_frames(camera, body.feature))}


class FramesBody(BaseModel):
    feature: str
    frames: list[str]
    note: str = ""
    via: str | None = None  # the tool the delete was made from


@router.post("/cameras/{camera}/classify/delete-preview")
def delete_preview(camera: str, body: FramesBody) -> dict:
    """What deleting these frames would clear — shown before the user confirms."""
    require_feature(camera, body.feature)
    wanted = set(body.frames)
    labeled: set[str] = set()
    golden: set[str] = set()
    for feat in datamodel.list_features(camera):
        labeled |= wanted & set(labels.current_labels(camera, feat))
        golden |= wanted & {f for fs in labels.current_goldens(camera, feat).values() for f in fs}
    return {"total": len(wanted), "labeled": len(labeled), "golden": len(golden)}


@router.post("/cameras/{camera}/classify/delete-bulk")
def delete_bulk(camera: str, body: FramesBody) -> dict:
    require_feature(camera, body.feature)
    frames = list(dict.fromkeys(body.frames))
    if not frames:
        raise HTTPException(status_code=422, detail="No frames to delete.")
    return _delete_frames(camera, frames, body.note, body.via)


class LabelFramesBody(BaseModel):
    feature: str
    frames: list[str]
    cls: str
    via: str | None = None  # the page the selection came from (Dedup, ...), shown on the Verdict page


@router.post("/cameras/{camera}/classify/label-bulk")
def label_bulk(camera: str, body: LabelFramesBody) -> dict:
    """Label an explicit list of frames (e.g. a 2D-scatter selection) with one class."""
    require_feature(camera, body.feature)
    if body.cls not in datamodel.classes_for(camera, body.feature):
        raise HTTPException(status_code=422, detail=f"Unknown class: {body.cls}")
    frames = list(dict.fromkeys(body.frames))
    if not frames:
        raise HTTPException(status_code=422, detail="No frames to label.")
    for f in frames:
        frame_path(camera, f)
    return {"labeled": labels.set_labels_bulk(camera, body.feature, frames, body.cls, via=body.via)}


@router.post("/cameras/{camera}/classify/restore-bulk")
def restore_bulk(camera: str, body: FramesBody) -> dict:
    require_feature(camera, body.feature)
    frames = list(dict.fromkeys(body.frames))
    return {"restored": db.restore_frames(camera, frames)}


@router.get("/cameras/{camera}/classify/deleted")
def deleted_list(camera: str, feature: str) -> dict:
    """Soft-deleted frames of the camera with deletion time and note, newest first."""
    require_feature(camera, feature)
    return {"items": db.deleted_frames_info(camera)}


class NoteBody(BaseModel):
    feature: str
    frame: str
    note: str


@router.put("/cameras/{camera}/classify/deleted-note")
def deleted_note(camera: str, body: NoteBody) -> dict:
    require_feature(camera, body.feature)
    if not db.set_deleted_note(camera, body.frame, _clean_note(body.note)):
        raise HTTPException(status_code=404, detail="That frame is not deleted.")
    return {"frame": body.frame, "note": _clean_note(body.note)}


# --- bulk label --------------------------------------------------------------
class BulkBody(BaseModel):
    query: GridQuery
    mode: str
    lean_cls: str | None = None
    threshold: float | None = None
    label_as: str | None = None


def _bulk_ctx(camera: str, mode: str, lean_cls: str | None, q: GridQuery):
    if mode not in cv.BULK_MODES:
        raise HTTPException(status_code=422, detail=f"Unknown bulk mode: {mode}")
    ctx = _build(camera, q)
    if mode == "leaning" and lean_cls not in ctx.classes:
        raise HTTPException(status_code=422, detail=f"Unknown class: {lean_cls}")
    return ctx


@router.get("/cameras/{camera}/classify/bulk")
def bulk_preview(
    camera: str, q: QueryParams, mode: str = "leaning", lean_cls: str | None = None,
    threshold: float | None = None,
) -> dict:
    ctx = _bulk_ctx(camera, mode, lean_cls, q)
    picked, selectable, lo, hi, thr = cv.bulk_pick(
        ctx.items, rank_method=ctx.rank, mode=mode, lean_cls=lean_cls, threshold=threshold
    )
    return {"selectable": selectable, "selected": len(picked), "lo": lo, "hi": hi, "threshold": thr}


@router.post("/cameras/{camera}/classify/bulk")
def bulk_label(camera: str, body: BulkBody) -> dict:
    ctx = _bulk_ctx(camera, body.mode, body.lean_cls, body.query)
    if body.label_as not in ctx.classes:
        raise HTTPException(status_code=422, detail=f"Unknown class: {body.label_as}")
    picked, *_ = cv.bulk_pick(
        ctx.items, rank_method=ctx.rank, mode=body.mode, lean_cls=body.lean_cls, threshold=body.threshold
    )
    n = labels.set_labels_bulk(camera, body.query.feature, [r.frame for r in picked], body.label_as)
    return {"labeled": n, "counts": _counts(camera, body.query.feature)}


# --- bulk clear --------------------------------------------------------------
class ClearBody(BaseModel):
    query: GridQuery
    include_goldens: bool = False


@router.get("/cameras/{camera}/classify/clear")
def clear_preview(camera: str, q: QueryParams) -> dict:
    """What clearing the current view would touch: labeled frames, and goldens in it."""
    ctx = _build(camera, q)
    plain, goldens = cv.clear_pick(ctx.items, lab=ctx.lab, gold=ctx.gold, include_goldens=False)
    return {"matching": len(ctx.items), "labeled": len(plain), "goldens": goldens}


@router.post("/cameras/{camera}/classify/clear")
def clear_labels(camera: str, body: ClearBody) -> dict:
    """Clear labels of every labeled frame in the current view (all pages, not just the one shown).

    Goldens in the view are skipped unless ``include_goldens``; then their golden mark is
    removed together with the label. Source frames are never touched.
    """
    ctx = _build(camera, body.query)
    picked, spared = cv.clear_pick(
        ctx.items, lab=ctx.lab, gold=ctx.gold, include_goldens=body.include_goldens
    )
    cleared = labels.clear_labels_bulk(camera, body.query.feature, picked)
    return {
        "cleared": cleared,
        "goldens_spared": spared,
        "counts": _counts(camera, body.query.feature),
    }


# --- auto-assign -------------------------------------------------------------
class AutoBody(BaseModel):
    query: GridQuery
    classes: list[str] | None = None
    min_margin: float | None = None


@router.get("/cameras/{camera}/classify/auto")
def auto_preview(
    camera: str, q: QueryParams, classes: Annotated[list[str] | None, Query()] = None,
    min_margin: float | None = None,
) -> dict:
    # The preview is computed on the view *without* its own grid filter applied.
    ctx = _build(camera, q.model_copy(update={"auto_preview": False}))
    if not ctx.scored:
        return {"candidates": 0, "total": 0, "per_class": [], "lo": 0, "hi": 0, "min_margin": 0}
    picks, n_cand, lo, hi = _auto_picks(ctx, classes, min_margin)
    per_class = [
        {
            "cls": c,
            "count": len(rs),
            "avg_margin": (sum(r.per_method[ctx.rank].margin for r in rs) / len(rs)) if rs else None,
        }
        for c, rs in picks.items()
    ]
    return {
        "candidates": n_cand,
        "total": sum(len(rs) for rs in picks.values()),
        "per_class": per_class,
        "lo": lo,
        "hi": hi,
        "min_margin": lo if min_margin is None else min_margin,
    }


@router.post("/cameras/{camera}/classify/auto")
def auto_apply(camera: str, body: AutoBody) -> dict:
    ctx = _build(camera, body.query.model_copy(update={"auto_preview": False}))
    if not ctx.scored:
        raise HTTPException(status_code=409, detail="Nothing is scored yet — refresh scores first.")
    picks = _auto_picks(ctx, body.classes, body.min_margin)[0]
    written = 0
    for cls, rs in picks.items():
        if rs:
            written += labels.set_labels_bulk(
                camera, body.query.feature, [r.frame for r in rs], cls, source="auto"
            )
    return {"labeled": written, "counts": _counts(camera, body.query.feature)}


# --- suggested goldens -------------------------------------------------------
class PromoteBody(BaseModel):
    feature: str
    frame: str
    cls: str


@router.get("/cameras/{camera}/classify/suggest")
def suggest_goldens(camera: str, q: QueryParams, n: int = suggest_goldens_mod.DEFAULT_N) -> dict:
    """Most-uncertain unlabeled frames, spread for diversity. Empty unless two classes have goldens."""
    if not suggest_goldens_mod.N_MIN <= n <= suggest_goldens_mod.N_MAX:
        raise HTTPException(status_code=422, detail="n is out of range.")
    ctx = _build(camera, q.model_copy(update={"auto_preview": False}))
    have = [c for c in ctx.classes if ctx.gold.get(c)]
    empty = {"available": False, "picks": [], "backbone": None, "n_min": suggest_goldens_mod.N_MIN,
             "n_max": suggest_goldens_mod.N_MAX, "default_n": suggest_goldens_mod.DEFAULT_N}
    if not ctx.scored or len(have) < 2:
        return empty
    picks = suggest_goldens_mod.suggest(
        camera=camera, feature=q.feature, items=ctx.items, rank_method=ctx.rank, n=n,
        lab=ctx.lab, gold=ctx.gold,
    )
    if not picks:
        return empty
    return {
        **empty,
        "available": True,
        "backbone": suggest_goldens_mod._diversity_backbone(),
        "picks": [
            {
                "frame": fs.frame,
                "bars": cv.bars(fs.per_method[ctx.rank].dists, ctx.classes) if ctx.rank in fs.per_method else None,
            }
            for fs in picks
        ],
    }


@router.post("/cameras/{camera}/classify/promote")
def promote(camera: str, body: PromoteBody) -> dict:
    """Label a frame and make it a golden for that class in one action."""
    require_feature(camera, body.feature)
    frame_path(camera, body.frame)
    classes = datamodel.classes_for(camera, body.feature)
    if body.cls not in classes:
        raise HTTPException(status_code=422, detail=f"Unknown class: {body.cls}")
    labels.set_label(camera, body.feature, body.frame, body.cls, source="suggest")
    labels.mark_golden(camera, body.feature, body.frame, body.cls)
    return _result(camera, body.feature, body.frame, classes)
