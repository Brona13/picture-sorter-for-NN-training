"""The Export box at the end of the Chain (plan ``plans/export-box.md``).

It has two inputs, **OK** and **NG**. Lines into the same input are combined by intersection: a picture goes through
only when every line lets it. A picture that reaches both inputs is left out and reported. Golden pictures only (the
``goldens_only`` tick, default on: golden in at least one ROI). With a product Classifier the folders are
``<product>/OK`` and ``<product>/NG`` (a picture with no product is left out and counted), else ``OK`` and ``NG``.
Originals only, no manifest.

In step 1 the box is the **Freeze** module (``flow.step_of``): every OK / NG picture, no goldens, no product folders. The
step-2 Export is the goldens export.

Freeze first, export follows: a freeze stores a project version (the picture list with hashes, the Chain settings),
the export copies that version's pictures (``versions.export``). The box says when the Chain would now pick other
pictures than the last freeze.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter

import anchor
import dedup_box
import datamodel
import db
import ds_export
import flow
import labels
import lines
import model_sets
import roi_input
import versions

BOX_FORMATS = ("corners", "size")  # x1, y1, x2, y2 (two corners) or x, y, width, height (top-left corner and size); pixels of the picture


def anchored_box(camera: str, feature: str) -> str | None:
    """The Box a Classifier is anchored to, or ``None``."""
    spec = anchor.get_anchor(camera, feature)
    return spec["detector"] if spec and flow.kind_of(spec["detector"]) == "box" else None


def box_of(camera: str, node_id: str, graph: dict) -> str | None:
    """The Box whose rectangles an Export box lists: the one every Classifier on its lines is anchored to. ``None`` when
    there is none, or the Classifiers use different Boxes (the pictures are then exported without numbers)."""
    refs = [r for refs in flow.export_lines(graph, node_id).values() for r in refs if r.get("feature")]
    boxes = {anchored_box(camera, r["feature"]) for r in refs}
    return boxes.pop() if len(boxes) == 1 and None not in boxes else None


def box_numbers(camera: str, box_id: str, frames: list[str]) -> dict[str, tuple[int, int, int, int]]:
    """The Box's upright rectangle of each picture as whole pixels of the picture: ``(x1, y1, x2, y2)``, the edges. It is the
    rectangle a Classifier anchored to the Box is cut to (the same ``anchor.rect_for`` and pixel rounding as its cut-outs),
    so the numbers and the pictures agree. A picture with no rectangle is left out."""
    stored = flow.load_stored(camera, box_id)["frames"]
    sizes = flow._frame_sizes(camera)
    hmap = labels.hash_map(camera)
    out = {}
    for frame in frames:
        key = hmap.get(frame)
        entry = (stored.get(key) or {}).get("box") if key else None
        size = sizes.get(key) if key else None
        roi = anchor.rect_for({"mode": "box"}, entry, "box", size[0], size[1]) if entry and size else None
        if roi is not None:
            out[frame] = roi.to_pixels(size[0], size[1])
    return out


def box_row(numbers: tuple[int, int, int, int], box_format: str) -> list[int]:
    """The numbers in the chosen layout: the two corners, or the top-left corner and the size."""
    x1, y1, x2, y2 = numbers
    return [x1, y1, x2 - x1, y2 - y1] if box_format == "size" else [x1, y1, x2, y2]


def _line_frames(camera: str, graph: dict, ref: dict, live: set[str]) -> set[str]:
    """The pictures one line passes on (deleted and muted ones never); the same reading as a Merge's lines."""
    return flow.ref_frames(camera, graph, ref, live)


def selection(camera: str, node_id: str, graph: dict | None = None) -> dict[str, set[str] | None]:
    """The pictures that come through each input (the intersection of its lines); ``None`` for an input with no line."""
    graph = graph or flow.load_graph(camera)
    live = set(flow._live_frames(camera))
    out: dict[str, set[str] | None] = {}
    for where, refs in flow.export_lines(graph, node_id).items():
        sets = [_line_frames(camera, graph, ref, live) for ref in refs]
        out[where] = set.intersection(*sets) if sets else None
    return out


def safe_segment(name: str) -> str:
    """A product name as one folder name."""
    cleaned = "".join(c if c.isalnum() or c in "-_ ." else "-" for c in str(name)).strip(" .")
    return cleaned or "product"


def plan(camera: str, node_id: str) -> dict:
    """What an export from this box would write now: ``items`` (frame, folder) and the counts that explain it."""
    graph = flow.load_graph(camera)
    node = graph["nodes"].get(node_id)
    if node is None or node.get("kind") != "export":
        raise flow.FlowError(f"Unknown Export box: {node_id}")
    sel = selection(camera, node_id, graph)
    ok_in, ng_in = sel["ok"], sel["ng"]
    both = (ok_in & ng_in) if ok_in is not None and ng_in is not None else set()
    decided: dict[str, str] = {}  # Freeze: the pictures the user decided here (v1.163.0), by frame
    stale = 0
    if both and flow.step_of(node) == 1:
        decided, stale = _decided(camera, graph, node_id, both)
    goldens_only = flow.export_goldens_only(node)
    golden = labels.quality_golden_frames(camera) if goldens_only else set()
    product_roi = datamodel.classify_feature(camera) if flow.step_of(node) == 2 else None  # Freeze (step 1): plain OK / NG
    product_of = labels.current_labels(camera, product_roi) if product_roi else {}
    items: list[tuple[str, str]] = []
    not_golden = no_product = 0
    for cls, frames in (("OK", ok_in), ("NG", ng_in)):
        for frame in sorted(((frames or set()) - both) | {f for f, c in decided.items() if c == cls}):
            if goldens_only and frame not in golden:
                not_golden += 1
                continue
            if product_roi:
                product = product_of.get(frame)
                if not product:
                    no_product += 1
                    continue
                items.append((frame, f"{safe_segment(product)}/{cls}"))
            else:
                items.append((frame, cls))
    folders = Counter(folder for _, folder in items)
    refs = flow.export_lines(graph, node_id)
    box_id = box_of(camera, node_id, graph) if flow.step_of(node) == 2 else None  # step 2: the rectangles of the Box the Classifiers read
    with_box = 0
    if box_id:
        made = flow.load_stored(camera, box_id)["frames"]
        hmap = labels.hash_map(camera)
        with_box = sum(1 for frame, _ in items if hmap.get(frame) in made)
    return {
        "box": box_id, "with_box": with_box, "no_box": len(items) - with_box if box_id else 0,
        "box_format": node.get("box_format") if node.get("box_format") in BOX_FORMATS else "corners",
        "items": items,
        "folders": dict(sorted(folders.items())),
        "ok": sum(1 for _, f in items if f.endswith("OK")),
        "ng": sum(1 for _, f in items if f.endswith("NG")),
        "both": len(both),
        "decided": len(decided),
        "undecided": len(both) - len(decided),
        "stale": stale,
        "not_golden": not_golden,
        "no_product": no_product,
        "uses_product": bool(product_roi),
        "goldens_only": goldens_only,
        "lines": {k: len(v) for k, v in refs.items()},
    }


def _versions_of(camera: str, node_id: str) -> list[dict]:
    """The project versions frozen from this box, newest first."""
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT id, number, name, created, counts_json, stats_json FROM versions "
            "WHERE camera=? AND feature=? AND deleted IS NULL ORDER BY number DESC",
            (camera, versions.PROJECT),
        ).fetchall()
    finally:
        con.close()
    uid = (flow.load_graph(camera)["nodes"].get(node_id) or {}).get("uid")
    found = []
    for r in rows:
        try:
            stats = json.loads(r["stats_json"] or "{}")
        except ValueError:
            continue
        made = stats.get("export") or {}
        # A freeze lists under the box that made it, told apart by the box's uid, not by its name or number. A freeze or a box
        # from before v1.148.0 has no uid: those are matched by id as they always were (ids are no longer given twice).
        mine = made.get("uid") == uid if uid and made.get("uid") else made.get("box") == node_id
        if mine:
            found.append({"id": r["id"], "number": r["number"], "name": r["name"], "created": r["created"], "counts": json.loads(r["counts_json"] or "{}")})
    return found


def _where_exported(camera: str, v: dict) -> dict:
    """Whether a frozen version has been exported, and the folder an export writes (relative to the camera folder)."""
    dest = versions.export_dir(camera, v["number"], v["name"])
    return {"exported": dest.exists(), "folder": str(dest.relative_to(datamodel.camera_dir(camera)))}


def state(camera: str, node_id: str) -> dict:
    """What the Export page shows: the plan's counts per folder, every freeze of this box (``versions``, newest first)
    and the newest one again as ``latest``. Only the newest freeze says whether the Chain would now pick other pictures
    (``changed``); an older one is a record and is never compared."""
    p = plan(camera, node_id)
    rows = []
    for n, v in enumerate(_versions_of(camera, node_id)):
        row = {**v, **_where_exported(camera, v), "changed": False, "ds": ds_export.made(camera, v["id"])}
        if n == 0:
            was = {(i["frame"], i["class"]) for i in versions.load_items(v["id"])}
            row["changed"] = was != set(p["items"])
        rows.append(row)
    return {**{k: v for k, v in p.items() if k != "items"}, "total": len(p["items"]), "latest": rows[0] if rows else None, "versions": rows, "ds_fields": ds_export.last_fields(camera)}


def freeze(camera: str, node_id: str, name: str = "", notes: str = "") -> dict:
    """Freeze what this box would export now as the next project version. Returns ``{id, number, counts}``."""
    p = plan(camera, node_id)
    if not p["items"]:
        raise versions.NothingToFreezeError(
            "Nothing arrives at this Export box yet: connect lines to its OK or NG input."
            if not any(p["lines"].values()) else "No picture comes through the lines of this Export box."
        )
    counts = {"ok": p["ok"], "ng": p["ng"], "not_golden": p["not_golden"], "both": p["both"], "decided": p["decided"], "no_product": p["no_product"], "total": len(p["items"])}
    stats = {"export": {"goldens_only": 1 if p["goldens_only"] else 0, "box": node_id, "uid": flow.ensure_uid(camera, node_id), "source": "chain", "graph": flow.load_graph(camera)}}
    if p["box"]:  # the rectangles are frozen with the version, so the export of it is reproducible
        numbers = box_numbers(camera, p["box"], [frame for frame, _ in p["items"]])
        counts["with_box"] = len(numbers)
        stats["export"]["rectangles"] = {"box": p["box"], "format": p["box_format"], "rows": {frame: box_row(n, p["box_format"]) for frame, n in numbers.items()}}
        stats["export"]["sizes"] = model_sets.size_counts(camera, list(numbers))  # picture sizes of the pictures that have a rectangle (the Models page filters by them)
    return versions.insert_project_version(camera, name, notes, counts, stats, p["items"])


# --- the pictures that reach both inputs: the user's decisions (v1.163.0) --------------------------
DECISIONS_KEY = "freeze.decisions."  # setting freeze.decisions.<box> = {frame hash: {"cls": "OK" | "NG", "sig": signature of what the lines said}}


def _leaf_refs(graph: dict, ref: dict, _seen: frozenset = frozenset()) -> list[dict]:
    """The Classifier dots and Evaluation dots a line comes from, through any Merges."""
    if ref.get("from"):
        box = ref["from"]
        if flow.kind_of(box) == "merge" and box not in _seen and box in graph["nodes"]:
            return [leaf for r in flow.merge_lines(graph["nodes"][box]) for leaf in _leaf_refs(graph, r, _seen | {box})]
        return []
    return [ref] if ref.get("feature") or ref.get("box") else []


def _signer(camera: str, graph: dict, node_id: str):
    """A function frame -> signature of what the lines into the box say about it: for every Classifier dot its label, for
    every Evaluation dot its verdict. A decision made on other answers than the ones now is stale."""
    leaves = [leaf for refs in flow.export_lines(graph, node_id).values() for ref in refs for leaf in _leaf_refs(graph, ref)]
    feats = sorted({leaf["feature"] for leaf in leaves if leaf.get("feature")})
    boxes = sorted({leaf["box"] for leaf in leaves if leaf.get("box") and leaf["box"] in graph["nodes"]})
    labs = {f: labels.current_labels(camera, f) for f in feats}
    verdicts = {b: flow.evaluation_state(camera, b)["verdicts"] for b in boxes if flow.kind_of(b) == "evaluation"}

    def sign(frame: str) -> str:
        said = [("f", f, labs[f].get(frame)) for f in feats] + [("e", b, v.get(frame)) for b, v in verdicts.items()]
        return hashlib.sha1(json.dumps(said).encode()).hexdigest()[:12]

    return sign


def load_decisions(camera: str, node_id: str) -> dict[str, dict]:
    raw = db.get_setting(camera, f"{DECISIONS_KEY}{node_id}")
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _decided(camera: str, graph: dict, node_id: str, both: set[str]) -> tuple[dict[str, str], int]:
    """The decisions that still hold for the pictures that reach both inputs: ``({frame: "OK" | "NG"}, stale count)``.
    A decision goes stale when the answers of the lines changed since it was made."""
    stored = load_decisions(camera, node_id)
    if not stored:
        return {}, 0
    hmap = labels.hash_map(camera)
    sign = _signer(camera, graph, node_id)
    decided: dict[str, str] = {}
    stale = 0
    for frame in both:
        d = stored.get(hmap.get(frame) or "")
        if not d or d.get("cls") not in ("OK", "NG"):
            continue
        if d.get("sig") == sign(frame):
            decided[frame] = d["cls"]
        else:
            stale += 1
    return decided, stale


def set_decisions(camera: str, node_id: str, frames: list[str], cls: str | None) -> dict:
    """Decide pictures that reach both inputs of a Freeze box as ``cls`` (OK or NG), or take the decision back (``None``).
    A decision is for the freeze only: it changes no label anywhere. Returns the new counts."""
    graph = flow.load_graph(camera)
    node = graph["nodes"].get(node_id)
    if node is None or node.get("kind") != "export":
        raise flow.FlowError(f"Unknown Export box: {node_id}")
    if flow.step_of(node) != 1:
        raise flow.FlowError("Only a Freeze box (step 1) takes decisions.")
    if cls not in (None, "OK", "NG"):
        raise flow.FlowError("A decision is OK or NG.")
    sel = selection(camera, node_id, graph)
    both = (sel["ok"] & sel["ng"]) if sel["ok"] is not None and sel["ng"] is not None else set()
    unknown = [f for f in frames if f not in both]
    if unknown:
        raise flow.FlowError(f"{unknown[0]} does not reach both inputs of {node_id}, so there is nothing to decide.")
    stored = load_decisions(camera, node_id)
    hmap = labels.hash_map(camera)
    sign = _signer(camera, graph, node_id)
    for frame in frames:
        key = hmap.get(frame)
        if not key:
            continue
        if cls is None:
            stored.pop(key, None)
        else:
            stored[key] = {"cls": cls, "sig": sign(frame)}
    if stored:
        db.set_setting(camera, f"{DECISIONS_KEY}{node_id}", json.dumps(stored, sort_keys=True))
    else:
        db.delete_setting(camera, f"{DECISIONS_KEY}{node_id}")
    p = plan(camera, node_id)
    return {k: p[k] for k in ("both", "decided", "undecided", "stale", "ok", "ng")}


def contradictions(camera: str, node_id: str) -> dict:
    """The pictures that reach both the OK and the NG input of a Freeze box, with what the lines said and the decision:
    ``{"total", "decided", "undecided", "stale", "items": [{"frame", "ok_from", "ng_from", "features", "decision", "stale"}]}``."""
    graph = flow.load_graph(camera)
    node = graph["nodes"].get(node_id)
    if node is None or node.get("kind") != "export":
        raise flow.FlowError(f"Unknown Export box: {node_id}")
    sel = selection(camera, node_id, graph)
    both = (sel["ok"] & sel["ng"]) if sel["ok"] is not None and sel["ng"] is not None else set()
    if not both:
        return {"total": 0, "decided": 0, "undecided": 0, "stale": 0, "items": []}
    stored = load_decisions(camera, node_id)
    hmap = labels.hash_map(camera)
    sign = _signer(camera, graph, node_id)
    names = _box_names(camera, graph)
    lines_in = flow.export_lines(graph, node_id)

    def named(where: str) -> list[str]:
        out: list[str] = []
        for ref in lines_in.get(where, []):
            for leaf in _leaf_refs(graph, ref) or [ref]:
                label = (chain_label(camera, leaf["feature"]) or leaf["feature"].split("::")[-1]) if leaf.get("feature") else names.get(leaf.get("box") or leaf.get("from") or "", "")
                if label and label not in out:
                    out.append(label)
        return out

    ok_from, ng_from = named("ok"), named("ng")
    features = sorted({leaf["feature"] for refs in lines_in.values() for ref in refs for leaf in _leaf_refs(graph, ref) if leaf.get("feature")})
    items = []
    decided = stale = 0
    for frame in sorted(both):
        d = stored.get(hmap.get(frame) or "")
        valid = bool(d and d.get("cls") in ("OK", "NG") and d.get("sig") == sign(frame))
        old = bool(d and d.get("cls") in ("OK", "NG") and not valid)
        decided += valid
        stale += old
        if len(items) < LEFT_OUT_LIMIT:
            items.append({"frame": frame, "decision": d["cls"] if valid else None, "stale": old})
    return {"total": len(both), "decided": decided, "undecided": len(both) - decided, "stale": stale, "ok_from": ok_from, "ng_from": ng_from, "features": features, "items": items}


# --- the pictures that reach neither input --------------------------------------------------------
LEFT_OUT_LIMIT = 500  # the list is for looking at; the count is always the whole number


def _leaf_features(graph: dict, ref: dict, _seen: frozenset = frozenset()) -> list[str]:
    """The Classifiers whose dots a line comes from, through any Merges."""
    if ref.get("from"):
        box = ref["from"]
        if flow.kind_of(box) == "merge" and box not in _seen and box in graph["nodes"]:
            return [f for r in flow.merge_lines(graph["nodes"][box]) for f in _leaf_features(graph, r, _seen | {box})]
        return []
    return [ref["feature"]] if ref.get("feature") else []


def _box_names(camera: str, graph: dict) -> dict[str, str]:
    """The name of each box as the Chain shows it (the user's name, else the default)."""
    import chain  # noqa: PLC0415  (chain imports this module)

    stored = chain.load_layout(camera).get("nodes", {})
    names = {}
    for node_id, node in graph["nodes"].items():
        default = {"crop": "Picture edits", "detector": "Detector", "evaluation": "Evaluation", "dedup": "Dedup", "export": "Export", "merge": "Merge", "calc": "Calculate", "box": "Box"}.get(node.get("kind"), node.get("kind", "Box"))
        names[node_id] = (stored.get(node_id) or {}).get("label") or f"{default} {node_id.split(':')[-1]}"
    return names


def _passes(camera: str, graph: dict, box: str, frame: str) -> bool:
    """Whether a box hands this picture on (a Dedup box not when it muted it)."""
    names = set(flow.node_frames(camera, box, graph))
    if flow.kind_of(box) == "dedup":
        names -= db.muted_frames(camera, box)
    return frame in names


def _why_absent(camera: str, graph: dict, names: dict[str, str], feature: str, frame: str) -> str:
    """Why a picture is not among a Classifier's pictures: the first box above it that does not hand it on."""
    boxes = []
    spec = anchor.get_anchor(camera, feature)
    if spec:
        boxes.append(spec["detector"])
    spec = roi_input.get_input(camera, feature)
    if spec:
        boxes.append(spec["box"])
    boxes += dedup_box.inputs_of(camera, feature)
    for box in boxes:
        if box not in graph["nodes"] or _passes(camera, graph, box, frame):
            continue
        cur = box
        for _ in range(30):  # up the chain while the box above does not have it either
            up = flow.parent_of(graph, cur)
            if up and up in graph["nodes"] and not _passes(camera, graph, up, frame):
                cur = up
                continue
            break
        kind = flow.kind_of(cur)
        name = names.get(cur, cur)
        if kind == "dedup":
            return f"muted by {name}"
        if kind == "detector":
            return f"{name} found no target"
        if kind == "crop":
            return f"{name} has no rectangle here (the detector before it found nothing)"
        return f"not passed on by {name}"
    if frame in db.muted_frames(camera, feature):
        return "muted in this Classifier"
    return "not among this Classifier's pictures"


def left_out(camera: str, node_id: str) -> dict:
    """The pictures that reach neither the OK nor the NG input of this box (so a freeze leaves them out), and for each the
    Classifiers on its lines that gave it no label: ``{"total", "items": [{"frame", "missing": [{"classifier", "feature",
    "state", "why"}], "said": {classifier: label}}], "reasons": {text: count}}``. A picture labeled OK or NG by every Classifier is
    never in the list, so each listed one has at least one Classifier that has no label for it."""
    graph = flow.load_graph(camera)
    node = graph["nodes"].get(node_id)
    if node is None or node.get("kind") != "export":
        raise flow.FlowError(f"Unknown Export box: {node_id}")
    lines_in = flow.export_lines(graph, node_id)
    sel = selection(camera, node_id, graph)
    if not any(lines_in.values()):
        return {"total": 0, "items": [], "reasons": {}}
    live = flow._live_frames(camera)
    passed = (sel["ok"] or set()) | (sel["ng"] or set())
    left = [f for f in live if f not in passed]
    features: list[str] = []
    for refs in lines_in.values():
        for ref in refs:
            for f in _leaf_features(graph, ref):
                if f not in features:
                    features.append(f)
    names = _box_names(camera, graph)
    short = {f: (chain_label(camera, f) or f.split("::")[-1]) for f in features}
    scope = {f: set(datamodel.frames_for_feature(camera, f)) - db.muted_frames(camera, f) for f in features}
    labs = {f: labels.current_labels(camera, f) for f in features}
    items = []
    reasons: Counter = Counter()
    for frame in left:
        missing, said = [], {}
        for f in features:
            label = labs[f].get(frame) if frame in scope[f] else None
            if label:
                said[short[f]] = label
                continue
            if frame in scope[f]:
                why, state = "no label yet", "unlabeled"
            else:
                why, state = _why_absent(camera, graph, names, f, frame), "absent"
            missing.append({"classifier": short[f], "feature": f, "state": state, "why": why})
            reasons[f"{short[f]}: {why}"] += 1
        items.append({"frame": frame, "missing": missing, "said": said})
    return {"total": len(items), "items": items[:LEFT_OUT_LIMIT], "reasons": dict(reasons.most_common())}


def chain_label(camera: str, feature: str) -> str | None:
    """The name the user gave a Classifier on the Chain, if any."""
    import chain  # noqa: PLC0415

    return (chain.load_layout(camera).get("nodes", {}).get(chain.roi_node_id(feature)) or {}).get("label")
