"""The Export box at the end of the Chain (plan ``plans/export-box.md``).

It has two inputs, **OK** and **NG**. Lines into the same input are combined by intersection: a picture goes through
only when every line lets it. A picture that reaches both inputs is left out and reported. Golden pictures only (the
``goldens_only`` tick, default on: golden in at least one ROI). With a product Classifier the folders are
``<product>/OK`` and ``<product>/NG`` (a picture with no product is left out and counted), else ``OK`` and ``NG``.
Originals only, no manifest.

Freeze first, export follows: a freeze stores a project version (the picture list with hashes, the Chain settings),
the export copies that version's pictures (``versions.export``). The box says when the Chain would now pick other
pictures than the last freeze.
"""
from __future__ import annotations

import json
from collections import Counter

import datamodel
import db
import flow
import labels
import lines
import versions


def _line_frames(camera: str, graph: dict, ref: dict, live: set[str]) -> set[str]:
    """The pictures one line passes on (deleted and muted ones never)."""
    if ref.get("from"):
        box = ref["from"]
        if box == flow.INGEST_ID:
            return set(live)
        if box not in graph["nodes"]:
            return set()
        names = set(flow.node_frames(camera, box, graph))
        if flow.kind_of(box) == "dedup":
            names -= db.muted_frames(camera, box)
        return names & live
    if ref.get("box"):
        if ref["box"] not in graph["nodes"]:
            return set()
        return set(flow.verdict_frames(camera, ref["box"], ref["dot"])) & live
    try:
        return set(lines.frames_on_dot(camera, ref["feature"], ref["dot"])) & live
    except ValueError:  # a class that went away passes nothing
        return set()


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
    goldens_only = bool(node.get("goldens_only", True))
    golden = labels.quality_golden_frames(camera) if goldens_only else set()
    product_roi = datamodel.classify_feature(camera)
    product_of = labels.current_labels(camera, product_roi) if product_roi else {}
    items: list[tuple[str, str]] = []
    not_golden = no_product = 0
    for cls, frames in (("OK", ok_in), ("NG", ng_in)):
        for frame in sorted((frames or set()) - both):
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
    return {
        "items": items,
        "folders": dict(sorted(folders.items())),
        "ok": sum(1 for _, f in items if f.endswith("OK")),
        "ng": sum(1 for _, f in items if f.endswith("NG")),
        "both": len(both),
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
    found = []
    for r in rows:
        try:
            stats = json.loads(r["stats_json"] or "{}")
        except ValueError:
            continue
        if (stats.get("export") or {}).get("box") == node_id:
            found.append({"id": r["id"], "number": r["number"], "name": r["name"], "created": r["created"], "counts": json.loads(r["counts_json"] or "{}")})
    return found


def state(camera: str, node_id: str) -> dict:
    """What the Export page shows: the plan's counts per folder and the latest freeze of this box."""
    p = plan(camera, node_id)
    latest = None
    frozen = _versions_of(camera, node_id)
    if frozen:
        v = frozen[0]
        was = {(i["frame"], i["class"]) for i in versions.load_items(v["id"])}
        latest = {**v, "changed": was != set(p["items"]), "exported": versions.export_dir(camera, v["number"], v["name"]).exists(),
                  "folder": str(versions.export_dir(camera, v["number"], v["name"]).relative_to(datamodel.camera_dir(camera)))}
    return {**{k: v for k, v in p.items() if k != "items"}, "total": len(p["items"]), "latest": latest}


def freeze(camera: str, node_id: str, name: str = "", notes: str = "") -> dict:
    """Freeze what this box would export now as the next project version. Returns ``{id, number, counts}``."""
    p = plan(camera, node_id)
    if not p["items"]:
        raise versions.NothingToFreezeError(
            "Nothing arrives at this Export box yet: connect lines to its OK or NG input."
            if not any(p["lines"].values()) else "No picture comes through the lines of this Export box."
        )
    counts = {"ok": p["ok"], "ng": p["ng"], "not_golden": p["not_golden"], "both": p["both"], "no_product": p["no_product"], "total": len(p["items"])}
    stats = {"export": {"goldens_only": 1 if p["goldens_only"] else 0, "box": node_id, "source": "chain", "graph": flow.load_graph(camera)}}
    return versions.insert_project_version(camera, name, notes, counts, stats, p["items"])
