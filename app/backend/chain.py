"""Chain canvas: a per-camera map of the processing chain (Ingest -> product ROI -> feature ROIs).

The map is a *view* of the ROI definitions, not a second copy of them. Every box is Ingest or one row of
``rois``; every arrow is derived from those rows:

  * Ingest -> the product-sorting (classify) ROI;
  * Ingest -> a feature ROI that applies to the whole camera;
  * a product handle of the classify ROI -> a feature ROI scoped to that product, either by name
    (``"<product>::<roi>"``, locked) or through the ROI's ``products`` list.

Only the layout (box positions, display names, viewport) is stored, as the camera setting ``chain.canvas``.
Creating, connecting and deleting boxes goes through the existing ROI endpoints, so the invariants live in one place.
"""
from __future__ import annotations

import json
import math

import datamodel
import db
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
    if classify_id:
        add(INGEST_ID, classify_id)
    for roi in rois:
        if roi.role == "classify":
            continue
        target = roi_node_id(roi.name)
        owner = datamodel.split_feature(roi.name)[0]
        if classify_id and owner:
            add(classify_id, target, product_handle(owner), locked=True)
        elif classify_id and roi.products:
            for product in roi.products:
                add(classify_id, target, product_handle(product))
        else:
            add(INGEST_ID, target)
    return edges


def _column(node: dict) -> int:
    """The chain level a box belongs to: 0 Ingest, 1 the product-sorting ROI, 2 the feature ROIs."""
    return 0 if node["kind"] == "ingest" else 1 if node["role"] == "classify" else 2


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
    }]
    nodes += [_roi_node(camera, roi, stored.get(roi_node_id(roi.name), {})) for roi in rois]
    _place_missing(nodes)
    return {
        "camera": camera,
        "nodes": nodes,
        "edges": _edges(camera, rois, classify),
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
