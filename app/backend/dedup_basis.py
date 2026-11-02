"""What a Dedup box was calculated from, and what changed since (v1.139.0).

When a Dedup box clusters, it stores a **basis**: a short fingerprint of each box above it in its tree, of the pictures
it sees (its *set*) and of the picture it compares (its *view*). The Dedup page compares the basis with the Chain as it
is now and flags a changed view and a changed set separately, naming what changed ("Detector 2 was run again",
"Evaluation 1 tolerance changed", "Dedup 1 muted pictures changed").

Nothing is recomputed or changed by this: it only tells that the clusters, maps and mutes of the box rest on an older
Chain. Without a clustering there is no basis and nothing is flagged. Changing the box's view forgets the basis (the
clusters go with it). Stored in the camera setting ``dedup.basis.<box>``.

Other boxes (detectors, Picture edits, Calculate, Evaluation, Classifier) can use the same corner and wording later; the
per-box ``_parts`` and ``PART_TEXT`` are the place to extend.
"""
from __future__ import annotations

import hashlib
import json
import time

import db
import dedup_view
import flow

KEY_PREFIX = "dedup.basis."

#: (box kind, part) -> the end of the sentence after the box's name.
PART_TEXT = {
    ("detector", "settings"): "settings changed",
    ("detector", "run"): "was run again",
    ("crop", "steps"): "changed",
    ("calc", "settings"): "changed",
    ("evaluation", "nominal"): "nominal changed",
    ("evaluation", "tolerance"): "tolerance changed",
    ("evaluation", "zone"): "zone changed",
    ("dedup", "mutes"): "muted pictures changed",
    ("merge", "lines"): "lines changed",
    ("merge", "mode"): "mode changed",
    ("classifier", "labels"): "pictures on the dot changed",
}
DEFAULTS = {"crop": "Picture edits", "detector": "Detector", "calc": "Calculate", "evaluation": "Evaluation", "dedup": "Dedup", "merge": "Merge"}


def _h(obj: object) -> str:
    return hashlib.sha1(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:10]


def _key(box: str) -> str:
    return f"{KEY_PREFIX}{box}"


def _run_hash(camera: str, detector: str) -> str:
    """Changes whenever the detector is run again (or a box is moved by hand): its stored results as a whole."""
    return _h(db.get_setting(camera, flow._results_key(detector)) or "")


def _parts(camera: str, graph: dict, node_id: str) -> dict:
    node = graph["nodes"][node_id]
    kind = node["kind"]
    if kind == "detector":
        return {"settings": flow.signature(graph, node_id), "run": _run_hash(camera, node_id)}
    if kind == "crop":
        return {"steps": _h(flow.own_steps(graph, node_id))}
    if kind == "calc":
        return {"settings": _h([node.get("op"), node.get("a"), node.get("b"), node.get("clockwise")])}
    if kind == "evaluation":
        return {"nominal": node.get("nominal"), "tolerance": node.get("tolerance"), "zone": _h(node.get("zone"))}
    if kind == "dedup":
        return {"mutes": _h(sorted(db.muted_frames(camera, node_id)))}
    if kind == "merge":
        return {"lines": _h(node.get("lines")), "mode": node.get("mode")}
    return {}


def _label(camera: str, node_id: str) -> str:
    import chain  # noqa: PLC0415

    kind = flow.kind_of(node_id)
    entry = chain.load_layout(camera)["nodes"].get(node_id, {})
    return entry.get("label") or f"{DEFAULTS.get(kind or '', node_id)} {node_id.split(':')[-1]}"


def view_key(camera: str, box: str, graph: dict | None = None) -> str:
    """Changes when the picture the box compares changes: its own view, the Picture edits box or detector target its line
    comes from, or - where those cut around a found target - the places that target was found at."""
    import anchor  # noqa: PLC0415
    import roi_input  # noqa: PLC0415

    graph = graph or flow.load_graph(camera)
    parts: list[object] = [dedup_view.rule_key(camera, box)]
    edits = roi_input.get_input(camera, box)
    if edits:
        parts.append(roi_input.rule_key(camera, box))
    spec = anchor.get_anchor(camera, box)
    if spec:
        parts += [anchor.rule_key(spec, camera), _run_hash(camera, spec["detector"])]
    cutting: list = []
    chosen = dedup_view.active(camera, box, graph)
    if edits and edits["box"] in graph["nodes"]:
        cutting = flow.output_rects(graph, edits["box"])
    elif chosen and flow.kind_of(chosen.split("/")[0]) == "crop":
        cutting = flow.output_rects(graph, chosen)
    for step in cutting:
        follow = flow.step_follow(step)
        if follow and follow["detector"] in graph["nodes"]:
            parts.append(_run_hash(camera, follow["detector"]))
    return _h(parts)


def compute(camera: str, box: str) -> dict:
    """The basis of the box as the Chain is now."""
    graph = flow.load_graph(camera)
    boxes: dict[str, dict] = {}
    for node_id in dedup_view._ancestors(camera, box, graph):
        if node_id in graph["nodes"] and graph["nodes"][node_id]["kind"] not in ("export",):
            boxes[node_id] = {"label": _label(camera, node_id), "kind": graph["nodes"][node_id]["kind"], "parts": _parts(camera, graph, node_id)}
    source = (graph["nodes"].get(box) or {}).get("source")
    if isinstance(source, dict) and source.get("feature"):  # a Classifier dot: the pictures it passes are its labels
        import lines  # noqa: PLC0415

        try:
            names = lines.frames_on_dot(camera, source["feature"], source["dot"])
        except ValueError:
            names = []
        boxes[source["feature"]] = {"label": f"{source['feature']} ({source['dot']})", "kind": "classifier", "parts": {"labels": _h(sorted(names))}}
    seen = flow.node_frames(camera, box, graph)
    return {"set": _h(sorted(seen)), "count": len(seen), "view": view_key(camera, box, graph), "boxes": boxes}


def save(camera: str, box: str) -> None:
    """Remember what the box was just calculated from."""
    db.set_setting(camera, _key(box), json.dumps({"at": int(time.time()), **compute(camera, box)}, sort_keys=True))


def clear(camera: str, box: str) -> None:
    db.delete_setting(camera, _key(box))


def _load(camera: str, box: str) -> dict | None:
    raw = db.get_setting(camera, _key(box))
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) and "boxes" in data else None


def compare(camera: str, box: str) -> dict | None:
    """``None`` when the box was never calculated; else whether its view and its set changed since, and what changed."""
    before = _load(camera, box)
    if before is None:
        return None
    now = compute(camera, box)
    changes: list[str] = []
    for node_id, old in before["boxes"].items():
        if node_id not in now["boxes"]:
            changes.append(f"{old['label']} was removed")
            continue
        new = now["boxes"][node_id]
        for part, value in new["parts"].items():
            if old["parts"].get(part) != value:
                changes.append(f"{new['label']} {PART_TEXT.get((new['kind'], part), 'changed')}")
    for node_id, new in now["boxes"].items():
        if node_id not in before["boxes"]:
            changes.append(f"{new['label']} was added")
    set_changed, view_changed = before.get("set") != now["set"], before.get("view") != now["view"]
    if not (set_changed or view_changed):
        changes = []  # a change upstream that alters neither the pictures nor the view the box compares is not worth a flag
    elif set_changed and not changes:
        changes.append(f"The pictures it sees changed ({before.get('count', 0)} before, {now['count']} now)")
    return {"view_changed": view_changed, "set_changed": set_changed, "changes": changes}
