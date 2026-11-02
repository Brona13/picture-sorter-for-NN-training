"""Ingest OK and Ingest NG: where step 2 of the two-step solution starts (plan ``plans/two-step-solution.md``, stage 2).

Each box is a pile of pictures: the OK (or NG) pictures of the **last freeze** of step 1 (a step-1 Export box, the Freeze
module). Only the labels cross between the steps, so the pile is read from the frozen version, not from the live Chain:
step 1 may change afterwards without moving step 2 until it is frozen again. Pictures deleted or taken out since the freeze
are left out. Without a Freeze module, or before its first freeze, a pile is empty and says why.
"""
from __future__ import annotations

import export_box
import flow
import versions

# Box kind -> the class of the frozen pictures it holds.
CLASS_OF = {"ingest_ok": "OK", "ingest_ng": "NG"}


def freeze_boxes(graph: dict) -> list[str]:
    """The Freeze modules: the Export boxes of step 1."""
    return sorted(i for i, n in graph["nodes"].items() if n.get("kind") == "export" and flow.step_of(n) == 1)


def last_freeze(camera: str, graph: dict | None = None) -> dict | None:
    """The newest frozen version of any Freeze module (``{id, number, box}``), or ``None``."""
    graph = graph or flow.load_graph(camera)
    newest = None
    for box in freeze_boxes(graph):
        latest = next(iter(export_box._versions_of(camera, box)), None)
        if latest and (newest is None or latest["number"] > newest["number"]):
            newest = {"id": latest["id"], "number": latest["number"], "box": box}
    return newest


def frames(camera: str, node_id: str, graph: dict | None = None) -> list[str]:
    """The pictures of the pile: the ones of its class in the last freeze that are still in use."""
    graph = graph or flow.load_graph(camera)
    cls = CLASS_OF[flow.kind_of(node_id)]
    frozen = last_freeze(camera, graph)
    if frozen is None:
        return []
    live = set(flow._live_frames(camera))
    return sorted(i["frame"] for i in versions.load_items(frozen["id"]) if i["class"] == cls and i["frame"] in live)


def summary(camera: str, node_id: str, graph: dict | None = None) -> dict:
    """What the Chain shows on the box: the picture count, the freeze it reads and, when it has none, why."""
    graph = graph or flow.load_graph(camera)
    frozen = last_freeze(camera, graph)
    if frozen is not None:
        warning = None
    elif not freeze_boxes(graph):
        warning = "Step 1 has no Freeze module."
    else:
        warning = "Step 1 is not frozen yet."
    return {"frames": len(frames(camera, node_id, graph)), "freeze": frozen["number"] if frozen else None, "warning": warning, "cls": CLASS_OF[flow.kind_of(node_id)]}
