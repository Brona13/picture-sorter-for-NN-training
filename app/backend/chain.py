"""Chain canvas: a per-camera map of the processing chain (Ingest -> product Classifier -> feature Classifiers).

The map is a *view* of the ROI definitions, not a second copy of them. Every box is Ingest or one row of ``rois``
(a **Classifier**: its ROI and its labeling in one box) or a measurement box (``flow.py``). A Classifier in mode
*product* sorts every picture of the camera into products; one in mode *feature* labels its own classes (OK / NG).
Each class is a dot on the box, and an "all" dot passes every classified picture (see ``lines.py``). Every line
is derived from the ROI rows:

  * Ingest -> the product Classifier, locked;
  * Ingest -> a feature Classifier that applies to the whole camera;
  * a product dot (or the "all" dot) of the product Classifier -> a feature Classifier scoped to that product, either by
    name (``"<product>::<roi>"``, locked) or through the ROI's ``products`` list.

The Evaluation a Classifier shows on its cards is picked in its panel and stored as before (an arrow ``eval ->
classify:<feature>`` in the flow graph); it is not drawn as a line.

Only the layout (box positions, display names, viewport) is stored, as the camera setting ``chain.canvas``.
Creating, connecting and deleting boxes goes through the existing ROI endpoints, so the invariants live in one place.
"""
from __future__ import annotations

import json
import math

import anchor
import roi_input
import datamodel
import db
import dedup_box
import flow
import labels
import lines
import preprocess

SETTING_KEY = "chain.canvas"
INGEST_ID = "ingest"
LABEL_MAX = 60
# Auto-placement of boxes that have no stored position yet: one column per level of the chain.
COLUMN_WIDTH = 280.0
ROW_HEIGHT = 150.0


class ChainError(ValueError):
    """The submitted layout is not acceptable."""


def roi_node_id(feature: str) -> str:
    return f"roi:{feature}"


def classify_node_id(feature: str) -> str:
    return f"classify:{feature}"


def product_handle(product: str) -> str:
    return f"p:{product}"


ALL_HANDLE = lines.ALL_DOT  # the dot that passes every classified picture


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ChainError(f"{name} must be a finite number.")
    return float(value)


def clean_layout(raw: object) -> dict:
    """Validate a submitted layout; ``{"nodes": {id: {label?, x, y}}, "viewport": {x, y, zoom} | None}``."""
    if not isinstance(raw, dict):
        raise ChainError("The layout must be an object.")
    nodes_raw = raw.get("nodes") or {}
    if not isinstance(nodes_raw, dict):
        raise ChainError("nodes must be an object keyed by box id.")
    nodes: dict[str, dict] = {}
    for node_id, entry in nodes_raw.items():
        if not isinstance(entry, dict):
            raise ChainError(f"Box {node_id!r} must be an object.")
        node = {"x": _number(entry.get("x"), "x"), "y": _number(entry.get("y"), "y")}
        label = entry.get("label")
        if label is not None:
            label = str(label).strip()
            if len(label) > LABEL_MAX:
                raise ChainError(f"A box name can have at most {LABEL_MAX} characters.")
            if label:
                node["label"] = label
        nodes[str(node_id)] = node
    viewport = raw.get("viewport")
    if viewport is not None:
        if not isinstance(viewport, dict):
            raise ChainError("viewport must be an object.")
        zoom = _number(viewport.get("zoom"), "zoom")
        if zoom <= 0:
            raise ChainError("zoom must be positive.")
        viewport = {"x": _number(viewport.get("x"), "x"), "y": _number(viewport.get("y"), "y"), "zoom": zoom}
    return {"nodes": nodes, "viewport": viewport}


def load_layout(camera: str) -> dict:
    """The stored layout, or an empty one when nothing (usable) is stored."""
    raw = db.get_setting(camera, SETTING_KEY)
    if not raw:
        return {"nodes": {}, "viewport": None}
    try:
        return clean_layout(json.loads(raw))
    except (ValueError, TypeError):
        return {"nodes": {}, "viewport": None}


def save_layout(camera: str, raw: object) -> dict:
    """Validate and store the layout. Raises :class:`ChainError`."""
    layout = clean_layout(raw)
    db.set_setting(camera, SETTING_KEY, json.dumps(layout, sort_keys=True))
    return layout


def _frame_count(camera: str, feature: str | None) -> int:
    if feature is None:
        return len(datamodel.list_unsorted(camera))
    return len(datamodel.frames_for_feature(camera, feature))


def _roi_node(camera: str, roi: datamodel.ROI, stored: dict) -> dict:
    """A Classifier box: the ROI and its labeling in one. ``mode`` is "product" for the product-sorting ROI, else "feature"."""
    owner, short = datamodel.split_feature(roi.name)
    if roi.role == "classify":
        scope = "classify"
    elif owner:
        scope = "name"
    elif roi.products:
        scope = "products"
    else:
        scope = "camera"
    current = labels.current_labels(camera, roi.name)
    classes = list(datamodel.classes_for(camera, roi.name))
    # The product-sorting ROI labels every picture of the camera; a feature ROI only those it applies to.
    frames = _frame_count(camera, None if roi.role == "classify" else roi.name)
    return {
        "id": roi_node_id(roi.name),
        "kind": "roi",
        "ref": roi.name,
        "label": stored.get("label") or short,
        "x": stored.get("x"),
        "y": stored.get("y"),
        "role": roi.role,
        "mode": "product" if roi.role == "classify" else "feature",
        "scope": scope,
        "product": owner,
        "products": list(roi.products or []),
        "classes": classes,
        "frames": frames,
        "labeled": len(current),
        "product_counts": {c: sum(1 for v in current.values() if v == c) for c in classes},
        "unlabeled": max(0, frames - len(current)),
        "deleted": len(db.deleted_frames_of(camera)),
        "evaluation": flow.feature_evaluation(camera, roi.name),
        "anchor": anchor.get_anchor(camera, roi.name),
        "input": (roi_input.get_input(camera, roi.name) or {}).get("box"),
    }


def _edges(camera: str, rois: list[datamodel.ROI], classify: str | None) -> list[dict]:
    edges: list[dict] = []

    def add(source: str, target: str, handle: str | None = None, locked: bool = False) -> None:
        edges.append({
            "id": f"{source}{'#' + handle if handle else ''}->{target}",
            "source": source,
            "source_handle": handle,
            "target": target,
            "locked": locked,
        })

    classify_id = roi_node_id(classify) if classify else None
    classes = datamodel.classes_for(camera, classify) if classify else []
    anchored = {r.name for r in rois if anchor.get_anchor(camera, r.name) or roi_input.get_input(camera, r.name) or dedup_box.input_of(camera, r.name)}  # these hang from their detector, Picture edits or Dedup box instead
    detached = {r.name for r in rois if db.get_setting(camera, f"{db.DETACHED_KEY}{r.name}") == "1"}  # drawn without the line from Ingest
    if classify_id:
        add(INGEST_ID, classify_id, locked=True)
    for roi in rois:
        if roi.role == "classify":
            continue
        target = roi_node_id(roi.name)
        owner = datamodel.split_feature(roi.name)[0]
        if classify_id and owner:
            add(classify_id, target, product_handle(owner), locked=True)
        elif classify_id and roi.products:
            if len(classes) > 1 and set(roi.products) >= set(classes):
                add(classify_id, target, ALL_HANDLE)  # every product: the "all" dot (classified pictures only)
            else:
                for product in roi.products:
                    add(classify_id, target, product_handle(product))
        elif roi.name not in anchored and roi.name not in detached:
            add(INGEST_ID, target)
    return edges


def _flow_nodes(camera: str, graph: dict, stored: dict) -> list[dict]:
    """The detector / Calculate / Evaluation boxes, with a light summary each (details come from the flow API)."""
    nodes = []
    for node_id, node in sorted(graph["nodes"].items()):
        kind = node["kind"]
        summary: dict = {}
        if kind == "crop":
            fid = flow.follow_step_id(graph, node_id)
            steps = [
                {"op": "filter", "label": preprocess.FILTERS[st["name"]]["label"], "enabled": st.get("enabled") is not False} if st["op"] == "filter"
                else {"op": "crop", "rect": None if st["id"] == fid else st.get("rect"), "follows": st["id"] == fid, "enabled": st.get("enabled") is not False}
                for st in flow.crop_steps(node)
            ]
            summary = {"steps": steps, "follow": flow.follow_of(graph, node_id), "source": flow.node_source(graph, node_id)}
            if summary["follow"]:
                spec = node.get("follow") or {}
                summary["follow"] = {**summary["follow"], "size": spec.get("size")}
        elif kind == "detector":
            summary = {"targets": [t["name"] for t in node["targets"]], "status": flow.status(camera, node_id, graph), **flow.summarize_detector(camera, node_id),
                       "source": flow.node_source(graph, node_id), "in_scope": len(flow.node_frames(camera, node_id, graph))}
        elif kind == "calc":
            a, b = flow.effective_points(graph, node_id)
            summary = {"op": node["op"], "a": a, "b": b}
        elif kind == "dedup":
            summary = {
                "source": dedup_box.source_of(camera, node_id, graph),
                "frames": len(dedup_box.frames(camera, node_id)),
                "muted": len(db.muted_frames(camera, node_id)),
                "deleted": len(db.deleted_frames_of(camera)),
                "feeds": dedup_box.fed_by(camera).get(node_id, []),
            }
        else:
            state = flow.evaluation_state(camera, node_id)
            summary = {"nominal": node["nominal"], "tolerance": node["tolerance"], "unit": state["unit"], "counts": state["counts"]}
        default = {"crop": "Picture edits", "detector": "Detector", "calc": "Calculate", "evaluation": "Evaluation", "dedup": "Dedup"}[kind]
        entry = stored.get(node_id, {})
        nodes.append({
            "id": node_id, "kind": kind, "ref": None, "label": entry.get("label") or f"{default} {node_id.split(':')[1]}",
            "x": entry.get("x"), "y": entry.get("y"), "role": None, "scope": None, "product": None, "products": [],
            "classes": [], "frames": 0, "labeled": 0, "product_counts": {}, "unlabeled": 0, "flow": summary,
        })
    return nodes


def overview_flow(camera: str, picture_frame: str | None) -> dict | None:
    """What the Overview shows of the measurement boxes: a light summary of each (same as on the Chain) and the boxes
    the detectors found on ``picture_frame``, placed on the whole picture. ``None`` when the camera has no such boxes."""
    graph = flow.load_graph(camera)
    if not graph["nodes"]:
        return None
    stored = load_layout(camera)["nodes"]
    order = {"crop": 0, "detector": 1, "calc": 2, "evaluation": 3, "dedup": 4}
    nodes = sorted(_flow_nodes(camera, graph, stored), key=lambda n: (order[n["kind"]], n["id"]))
    boxes: list[dict] = []
    size = None
    key = db.frame_hash_for(camera, picture_frame) if picture_frame else None
    if key:
        try:
            from PIL import Image  # noqa: PLC0415

            with Image.open(datamodel.unsorted_dir(camera) / picture_frame) as im:
                size = im.size
        except Exception:  # noqa: BLE001 - no readable picture, so nothing to draw on
            size = None
    if size:
        for node in nodes:
            if node["kind"] != "detector":
                continue
            found = flow.load_stored(camera, node["id"])["frames"].get(key) or {}
            rects = flow.input_rects(graph, node["id"])
            try:
                where = flow.rect_map(rects, *size, found=flow.Finder(camera).for_frame(key) if flow.has_follow(rects) else None)
            except flow.NoCrop:
                continue
            for target, box in found.items():
                x, y = where.point(box["x"], box["y"])
                boxes.append({
                    "detector": node["id"], "target": target, "x": x, "y": y,
                    "w": box["w"], "h": box["h"], "angle": box.get("angle", 0.0) + where.turn, "source": box.get("source", "auto"),
                })
    return {
        "nodes": [{"id": n["id"], "kind": n["kind"], "label": n["label"], "summary": n["flow"]} for n in nodes],
        "boxes": boxes,
        "size": {"w": size[0], "h": size[1]} if size else None,
    }


def _column(node: dict) -> int:
    """The chain level of a box: 0 Ingest, 1 product Classifier, 3 feature Classifiers (measurement boxes sit between)."""
    if node["kind"] == "ingest":
        return 0
    if node["kind"] in ("crop", "detector", "dedup"):
        return 1
    if node["kind"] == "calc":
        return 2
    if node["kind"] == "evaluation":
        return 3
    return 1 if node["role"] == "classify" else 3


def _place_missing(nodes: list[dict]) -> None:
    """Give every box without a stored position a spot below the others of its column."""
    bottoms: dict[int, float] = {}
    for node in nodes:
        if node["x"] is not None and node["y"] is not None:
            column = _column(node)
            bottoms[column] = max(bottoms.get(column, node["y"]), node["y"])
    for node in nodes:
        if node["x"] is not None and node["y"] is not None:
            continue
        column = _column(node)
        node["x"] = column * COLUMN_WIDTH
        node["y"] = bottoms[column] + ROW_HEIGHT if column in bottoms else 0.0
        bottoms[column] = node["y"]


def get_canvas(camera: str) -> dict:
    """The canvas as the UI draws it: boxes (stored layout + live status) and the arrows derived from the ROIs."""
    graph = flow.load_graph(camera)  # first: an old graph is migrated here, together with the stored layout
    layout = load_layout(camera)
    rois = datamodel.load_rois(camera)
    classify = datamodel.classify_feature(camera)
    stored = layout["nodes"]

    nodes = [{
        "id": INGEST_ID,
        "kind": "ingest",
        "ref": None,
        "label": stored.get(INGEST_ID, {}).get("label") or "Ingest",
        "x": stored.get(INGEST_ID, {}).get("x"),
        "y": stored.get(INGEST_ID, {}).get("y"),
        "role": None,
        "scope": None,
        "product": None,
        "products": [],
        "classes": [],
        "frames": _frame_count(camera, None),
        "labeled": 0,
        "product_counts": {},
        "unlabeled": 0,
    }]
    for roi in rois:
        nodes.append(_roi_node(camera, roi, stored.get(roi_node_id(roi.name), {})))
    nodes.extend(_flow_nodes(camera, graph, stored))
    _place_missing(nodes)
    edges = _edges(camera, rois, classify)
    known = {n["id"] for n in nodes}
    for e in graph["edges"]:
        if e["source"] in known and e["target"] in known:
            point = e.get("point")
            edges.append({
                "id": f"{e['source']}->{e['target']}" + (f"#{point}" if point else ""),
                "source": e["source"], "source_handle": f"t:{point}" if point else None, "target": e["target"], "locked": False,
            })
    for roi in rois:  # a detector-anchored ROI hangs from the detector too (the arrow is stored in the anchor)
        spec = anchor.get_anchor(camera, roi.name)
        if spec and spec["detector"] in known:
            edges.append({"id": f"{spec['detector']}->{roi_node_id(roi.name)}", "source": spec["detector"], "source_handle": f"t:{spec['target']}", "target": roi_node_id(roi.name), "locked": False})
    reading = sorted(i for i, n in graph["nodes"].items() if n["kind"] in ("dedup", "crop", "detector"))
    for box in reading:  # a Dedup, Picture edits or detector box reading one dot of a Classifier hangs from that dot
        src = dedup_box.source_of(camera, box, graph)
        if src and roi_node_id(src["feature"]) in known and box in known:
            handle = ALL_HANDLE if src["dot"] == ALL_HANDLE else product_handle(src["dot"])
            edges.append({"id": f"{roi_node_id(src['feature'])}#{handle}->{box}", "source": roi_node_id(src["feature"]), "source_handle": handle, "target": box, "locked": False})
    for roi in rois:  # a Classifier read through a Dedup box hangs from it
        box = dedup_box.input_of(camera, roi.name)
        if box and box in known:
            edges.append({"id": f"{box}->{roi_node_id(roi.name)}", "source": box, "source_handle": None, "target": roi_node_id(roi.name), "locked": False})
    for roi in rois:  # a ROI fed by a Picture edits box hangs from it
        spec = roi_input.get_input(camera, roi.name)
        if spec and spec["box"] in known:
            edges.append({"id": f"{spec['box']}->{roi_node_id(roi.name)}", "source": spec["box"], "source_handle": None, "target": roi_node_id(roi.name), "locked": False})
    return {
        "camera": camera,
        "nodes": nodes,
        "edges": edges,
        "products": datamodel.products(camera),
        "classify": classify,
        "viewport": layout["viewport"],
    }


def delete_preview(camera: str, feature: str) -> dict:
    """What deleting this ROI box would remove (counts), without removing anything."""
    roi = datamodel.get_roi(camera, feature)
    if roi is None:
        raise ChainError(f"Unknown ROI: {feature}")
    con = db.connect()
    try:
        def count(table: str) -> int:
            return con.execute(
                f"SELECT COUNT(*) FROM {table} WHERE camera=? AND feature=?", (camera, feature)
            ).fetchone()[0]

        counts = {
            "labels": count("labels"),
            "goldens": count("goldens"),
            "detections": count("detections"),
            "versions": count("versions"),
        }
    finally:
        con.close()
    # Product-scoped ROIs (``<product>::<roi>``) are separate boxes; the delete does not remove them.
    dependents = []
    if roi.role == "classify":
        dependents = [r.name for r in datamodel.load_rois(camera) if datamodel.split_feature(r.name)[0]]
    return {"feature": feature, "role": roi.role, "counts": counts, "dependents": dependents}
