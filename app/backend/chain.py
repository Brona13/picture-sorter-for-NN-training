"""Chain canvas: a per-camera map of the processing chain (Ingest -> product ROI -> feature ROIs).

The map is a *view* of the ROI definitions, not a second copy of them. Every box is Ingest, one row of ``rois``,
or the Classify box of an ROI (the labeling step; it exists whenever its ROI does). The Classify box of the
product-sorting ROI tells which picture belongs to which product; that of a feature ROI labels its classes
(OK / NG). Every arrow is derived from those rows:

  * Ingest -> the product-sorting (classify) ROI -> its Classify box;
  * Ingest -> a feature ROI that applies to the whole camera;
  * a product handle of the product ROI's Classify box -> a feature ROI scoped to that product, either by name
    (``"<product>::<roi>"``, locked) or through the ROI's ``products`` list;
  * every feature ROI -> its own Classify box.

Only the layout (box positions, display names, viewport) is stored, as the camera setting ``chain.canvas``.
Creating, connecting and deleting boxes goes through the existing ROI endpoints, so the invariants live in one place.
"""
from __future__ import annotations

import json
import math

import anchor
import datamodel
import db
import flow
import labels

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
    owner, short = datamodel.split_feature(roi.name)
    if roi.role == "classify":
        scope = "classify"
    elif owner:
        scope = "name"
    elif roi.products:
        scope = "products"
    else:
        scope = "camera"
    return {
        "id": roi_node_id(roi.name),
        "kind": "roi",
        "ref": roi.name,
        "label": stored.get("label") or short,
        "x": stored.get("x"),
        "y": stored.get("y"),
        "role": roi.role,
        "scope": scope,
        "product": owner,
        "products": list(roi.products or []),
        "classes": list(datamodel.classes_for(camera, roi.name)),
        "frames": _frame_count(camera, roi.name),
        "labeled": len(labels.current_labels(camera, roi.name)),
        "product_counts": {},
        "unlabeled": 0,
        "anchor": anchor.get_anchor(camera, roi.name),
    }


def _classify_node(camera: str, roi: datamodel.ROI, stored: dict) -> dict:
    """The labeling step of the product-sorting ROI: how many pictures are in each product, and how many are not yet."""
    current = labels.current_labels(camera, roi.name)
    classes = list(datamodel.classes_for(camera, roi.name))
    counts = {c: sum(1 for v in current.values() if v == c) for c in classes}
    # The product-sorting ROI labels every picture of the camera; a feature ROI only those it applies to.
    frames = _frame_count(camera, None if roi.role == "classify" else roi.name)
    return {
        "id": classify_node_id(roi.name),
        "kind": "classify",
        "ref": roi.name,
        "label": stored.get("label") or "Classify",
        "x": stored.get("x"),
        "y": stored.get("y"),
        "role": roi.role,
        "scope": None,
        "product": None,
        "products": [],
        "classes": classes,
        "frames": frames,
        "labeled": len(current),
        "product_counts": counts,
        "unlabeled": max(0, frames - len(current)),
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

    classify_id = classify_node_id(classify) if classify else None
    anchored = {r.name for r in rois if anchor.get_anchor(camera, r.name)}  # these hang from their detector instead
    if classify_id:
        add(INGEST_ID, roi_node_id(classify), locked=True)
        add(roi_node_id(classify), classify_id, locked=True)
    for roi in rois:
        if roi.role == "classify":
            continue
        add(roi_node_id(roi.name), classify_node_id(roi.name), locked=True)
        target = roi_node_id(roi.name)
        owner = datamodel.split_feature(roi.name)[0]
        if classify_id and owner:
            add(classify_id, target, product_handle(owner), locked=True)
        elif classify_id and roi.products:
            for product in roi.products:
                add(classify_id, target, product_handle(product))
        elif roi.name not in anchored:
            add(INGEST_ID, target)
    return edges


def _flow_nodes(camera: str, graph: dict, stored: dict) -> list[dict]:
    """The detector / Calculate / Evaluation boxes, with a light summary each (details come from the flow API)."""
    nodes = []
    for node_id, node in sorted(graph["nodes"].items()):
        kind = node["kind"]
        summary: dict = {}
        if kind == "crop":
            summary = {"rect": node["rect"], "follow": flow.follow_of(graph, node_id)}
            if summary["follow"]:
                spec = node.get("follow") or {}
                summary["follow"] = {**summary["follow"], "size": spec.get("size")}
        elif kind == "detector":
            summary = {"targets": [t["name"] for t in node["targets"]], "status": flow.status(camera, node_id, graph), **flow.summarize_detector(camera, node_id)}
        elif kind == "calc":
            a, b = flow.effective_points(graph, node_id)
            summary = {"op": node["op"], "a": a, "b": b}
        else:
            state = flow.evaluation_state(camera, node_id)
            summary = {"nominal": node["nominal"], "tolerance": node["tolerance"], "unit": state["unit"], "counts": state["counts"]}
        default = {"crop": "Crop", "detector": "Detector", "calc": "Calculate", "evaluation": "Evaluation"}[kind]
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
    order = {"crop": 0, "detector": 1, "calc": 2, "evaluation": 3}
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
                ox, oy = flow.rect_offset(rects, *size, found=flow.Finder(camera).for_frame(key) if flow.has_follow(rects) else None)
            except flow.NoCrop:
                continue
            for target, box in found.items():
                boxes.append({
                    "detector": node["id"], "target": target, "x": box["x"] + ox, "y": box["y"] + oy,
                    "w": box["w"], "h": box["h"], "angle": box.get("angle", 0.0), "source": box.get("source", "auto"),
                })
    return {
        "nodes": [{"id": n["id"], "kind": n["kind"], "label": n["label"], "summary": n["flow"]} for n in nodes],
        "boxes": boxes,
        "size": {"w": size[0], "h": size[1]} if size else None,
    }


def _column(node: dict) -> int:
    """The chain level of a box: 0 Ingest, 1 product ROI, 2 its Classify box, 3 feature ROIs, 4 their Classify boxes."""
    if node["kind"] == "ingest":
        return 0
    if node["kind"] in ("crop", "detector"):
        return 1
    if node["kind"] == "calc":
        return 2
    if node["kind"] == "evaluation":
        return 3
    if node["kind"] == "classify":
        return 2 if node["role"] == "classify" else 4
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
        nodes.append(_classify_node(camera, roi, stored.get(classify_node_id(roi.name), {})))
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
