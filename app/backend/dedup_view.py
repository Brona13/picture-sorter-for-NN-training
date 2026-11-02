"""The view of a Dedup box (v1.138.0): which part of the picture it compares.

A Dedup box fed by a Classifier dot or an Evaluation dot gets only a *set* of pictures on its line, no view: it saw the
whole picture. Such a box can now be told to look at one part instead (``node["view"] = {"id": ...}``):

  * ``crop:N``    the picture a Picture edits box passes on, cut by its crop steps only (a straightening crop gives the
                  straightened picture); filters and masks are not part of a view.
  * ``det:N/name``  the box a detector found for one target, cut upright (a turned box is turned back).

Only boxes found going UP the Dedup box's own tree toward Ingest are offered (``candidates``), never another branch. A
Dedup box offers no view itself. Multi-element targets (several boxes per picture) are left out for now.

When the line into the box already carries a view (a Picture edits box, a detector target dot) the line decides and the
list is read-only (``line_view``). A picture that has no such view (the detector found nothing there, a following crop has
no rectangle) does not pass: ``node_frames`` drops it for the box. The view only filters; it never changes a picture.
The pixels are the original ones of the chosen area.
"""
from __future__ import annotations

import hashlib
import json

import cv2
import numpy as np

import db
import flow
import labels

UPRIGHT_ANGLE = 0.01  # degrees; below this a found box is a plain upright cut


def _node(graph: dict, box: str) -> dict:
    return graph["nodes"].get(box) or {}


def line_view(camera: str, box: str, graph: dict | None = None) -> str | None:
    """What the line into the box already says about the view, or ``None`` when it carries only a set: ``"Picture edits N"``
    for a Picture edits box, ``"detector target"`` for a detector target dot, else a Classifier whose pictures are the boxes of a
    target."""
    import anchor  # noqa: PLC0415
    import roi_input  # noqa: PLC0415

    graph = graph or flow.load_graph(camera)
    if anchor.get_anchor(camera, box):
        return "a detector target"
    spec = roi_input.get_input(camera, box)
    if spec:
        return "its Picture edits box"
    return None


def selected(camera: str, box: str, graph: dict | None = None) -> str | None:
    """The view id stored on the box (even when the line overrides it, or it is no longer offered)."""
    graph = graph or flow.load_graph(camera)
    view = _node(graph, box).get("view")
    return view.get("id") if isinstance(view, dict) and isinstance(view.get("id"), str) else None


def _parse(view_id: str) -> tuple[str, str, str | None]:
    """``("crop", "crop:2", None)`` or ``("found", "det:1", "hole-left")``."""
    if "/" in view_id:
        det, target = view_id.split("/", 1)
        return "found", det, target
    return "crop", view_id, None


def _ancestors(camera: str, box: str, graph: dict) -> set[str]:
    """Every box above ``box``: by a line, by an Evaluation dot, by a Merge, and through a Classifier it reads."""
    import anchor  # noqa: PLC0415
    import roi_input  # noqa: PLC0415

    found = set(flow._upstream_ids(graph, box))
    src = _node(graph, box).get("source")
    feature = src.get("feature") if isinstance(src, dict) else None
    if feature:  # a Classifier dot: the Classifier hangs from a detector, a Picture edits box or Dedup boxes
        spec = anchor.get_anchor(camera, feature)
        edits = roi_input.get_input(camera, feature)
        roots = [spec["detector"]] if spec else []
        roots += [edits["box"]] if edits else []
        roots += db.dedup_inputs(camera, feature)
        for root in roots:
            if root in graph["nodes"]:
                found.add(root)
                found |= flow._upstream_ids(graph, root)
    found.discard(box)
    return found


def _number(node_id: str) -> int:
    tail = node_id.split(":", 1)[-1]
    return int(tail) if tail.isdigit() else 0


def candidates(camera: str, box: str, graph: dict | None = None) -> list[dict]:
    """The views the box can be set to, whole picture first: ``{"id", "label", "kind"}``. A Picture edits box that cuts
    nothing (filters only) is the whole picture again and is left out."""
    import chain  # noqa: PLC0415

    graph = graph or flow.load_graph(camera)
    names = chain.load_layout(camera)["nodes"]

    def name(node_id: str, default: str) -> str:
        return names.get(node_id, {}).get("label") or f"{default} {node_id.split(':')[1]}"

    out: list[dict] = [{"id": None, "label": "Whole picture", "kind": "whole"}]
    up = sorted(_ancestors(camera, box, graph), key=lambda i: (flow.kind_of(i) or "", _number(i)))
    for node_id in up:
        kind = flow.kind_of(node_id)
        if kind == "crop" and _geometry(flow.output_rects(graph, node_id)):
            out.append({"id": node_id, "label": f"{name(node_id, 'Picture edits')} (picture)", "kind": "crop"})
    for node_id in up:
        if flow.kind_of(node_id) == "detector":
            for target in graph["nodes"][node_id].get("targets", []):
                if flow.count_of(target) == 1 and target["examples"]:
                    out.append({"id": f"{node_id}/{target['name']}", "label": f"{name(node_id, 'Detector')}: {target['name']} (found box)", "kind": "found"})
    return out


def active(camera: str, box: str, graph: dict | None = None) -> str | None:
    """The view the box really uses: the stored one when the line carries none and it is still offered, else ``None``."""
    if flow.kind_of(box) != "dedup":
        return None
    graph = graph or flow.load_graph(camera)
    chosen = selected(camera, box, graph)
    if chosen is None or box not in graph["nodes"] or line_view(camera, box, graph):
        return None
    return chosen if any(c["id"] == chosen for c in candidates(camera, box, graph)) else None


def _geometry(rects: list) -> list:
    """The steps of a Picture edits chain that move or cut the picture: filters and masks are left out."""
    return [r for r in rects if not flow.is_filter(r) and not flow.is_mask(r)]


def _upright(image: np.ndarray, entry: dict) -> np.ndarray:
    """The found box of ``entry`` (centre pixel index ``x, y``, size ``w`` x ``h``, turned by ``angle`` counter-clockwise on
    screen) cut upright. A box with no turn is a plain cut at the picture's edge; a turned one is turned back about its centre."""
    h_img, w_img = image.shape[:2]
    w, h = max(1, int(entry["w"])), max(1, int(entry["h"]))
    ex, ey, angle = float(entry["x"]), float(entry["y"]), float(entry.get("angle", 0.0))
    if abs(((angle + 180.0) % 360.0) - 180.0) < UPRIGHT_ANGLE:
        x0, y0 = int(round(ex - (w - 1) / 2.0)), int(round(ey - (h - 1) / 2.0))
        x1, y1 = min(w_img, x0 + w), min(h_img, y0 + h)
        x0, y0 = max(0, x0), max(0, y0)
        if x1 - x0 < 1 or y1 - y0 < 1:
            raise FileNotFoundError("The found box lies outside the picture.")
        return image[y0:y1, x0:x1]
    m = cv2.getRotationMatrix2D((ex, ey), -angle, 1.0)
    m[0, 2] += (w - 1) / 2.0 - ex
    m[1, 2] += (h - 1) / 2.0 - ey
    return cv2.warpAffine(image, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def cut(camera: str, box: str, image: np.ndarray, frame: str) -> np.ndarray | None:
    """``image`` (the whole frame ``frame``) as the box's view shows it; ``None`` when the box has no active view. Raises
    ``FileNotFoundError`` when this picture has no such view (callers treat that as "no picture")."""
    graph = flow.load_graph(camera)
    view = active(camera, box, graph)
    if view is None:
        return None
    kind, node_id, target = _parse(view)
    try:
        if kind == "crop":
            rects = _geometry(flow.output_rects(graph, node_id))
            return flow.apply_rects(image, rects, flow._found_for(camera, rects, frame))[0]
        rects = _geometry(flow.input_rects(graph, node_id))
        entry = flow.Finder(camera).box(node_id, db.frame_hash_for(camera, frame) or "", target or "")
        if entry is None:
            raise FileNotFoundError(f"{node_id} found no {target} on {frame}.")
        picture = flow.apply_rects(image, rects, flow._found_for(camera, rects, frame))[0]
        return _upright(picture, entry)
    except flow.NoCrop as exc:
        raise FileNotFoundError(str(exc)) from exc


def with_view(camera: str, box: str, names: list[str], graph: dict | None = None) -> list[str]:
    """The pictures of ``names`` that have the box's view (all of them when the box has none)."""
    graph = graph or flow.load_graph(camera)
    view = active(camera, box, graph)
    if view is None:
        return names
    kind, node_id, target = _parse(view)
    hashes = labels.hash_map(camera)
    if kind == "found":
        stored = flow.load_stored(camera, node_id)["frames"]
        return [f for f in names if stored.get(hashes.get(f, ""), {}).get(target)]
    rects = _geometry(flow.output_rects(graph, node_id))
    if not flow.has_follow(rects):
        return names
    sizes, finder, kept = flow._frame_sizes(camera), flow.Finder(camera), []
    for f in names:
        key = hashes.get(f, "")
        size = sizes.get(key)
        if size is None:
            continue
        try:
            flow.rect_map(rects, size[0], size[1], finder.for_frame(key))
        except flow.NoCrop:
            continue
        kept.append(f)
    return kept


def summary(camera: str, box: str) -> dict:
    """What the Dedup page shows: the views on offer, the chosen one, who decides, and how many pictures have no view."""
    graph = flow.load_graph(camera)
    on_line = line_view(camera, box, graph)
    chosen = selected(camera, box, graph)
    options = candidates(camera, box, graph)
    if chosen is not None and not any(c["id"] == chosen for c in options):
        chosen = None  # the box it came from is gone or no longer above this one
    missing = 0
    if active(camera, box, graph) is not None:
        before = flow._node_frames(camera, box, graph)
        missing = len(before) - len(with_view(camera, box, before, graph))
    return {"candidates": options, "selected": chosen, "locked_by": on_line, "no_view": missing}


def rule_key(camera: str, box: str) -> str:
    """Part of the box's cache key (embeddings, thumbnails): changes when the view, the steps behind it or the boxes a
    detector found change. Empty without an active view."""
    graph = flow.load_graph(camera)
    view = active(camera, box, graph)
    if view is None:
        return ""
    kind, node_id, target = _parse(view)
    if kind == "crop":
        rects = _geometry(flow.output_rects(graph, node_id))
        material: object = [
            {**r, "sig": flow.signature(graph, flow.step_follow(r)["detector"])} if flow.step_follow(r) and flow.step_follow(r)["detector"] in graph["nodes"] else r
            for r in rects
        ]
    else:
        stored = db.get_setting(camera, flow._results_key(node_id)) or ""
        material = {"view": view, "found": hashlib.sha1(stored.encode()).hexdigest()[:12], "above": _geometry(flow.input_rects(graph, node_id))}
    return "dv=" + hashlib.sha1(json.dumps([view, material], sort_keys=True, default=str).encode()).hexdigest()[:12]
