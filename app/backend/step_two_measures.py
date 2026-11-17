"""The step-1 measurements over a picture of a step-2 Classifier (v1.164.0).

In step 2 the labels come from the last freeze; to see why a picture is OK or NG, the viewer can draw what every step-1
Evaluation judged on it: the rule's region (zone, angle wedge, distance ring, dx / dy band), the found boxes it needs and
the verdict's colour. Positions are on the whole picture (``flow.whole_picture_boxes``), the picture the step-2 viewer
shows. The drawing is the step-1 measurement as it is now, not as it was frozen; ``changed`` says when step 1 changed
since its last freeze. Nothing here labels or changes anything.
"""
from __future__ import annotations

import export_box
import flow
import roi_input


def available(camera: str, feature: str) -> bool:
    """Only a step-2 Classifier that shows the whole picture (no Picture edits box above it) gets the drawing."""
    return flow.roi_step(camera, feature) == 2 and roi_input.get_input(camera, feature) is None


def evaluations(graph: dict) -> list[tuple[str, str]]:
    """``(evaluation, calculate)`` of every step-1 Evaluation fed by a Calculate box, in box order."""
    out = []
    for node_id, node in graph["nodes"].items():
        if flow.kind_of(node_id) != "evaluation" or flow.step_of(node) != 1:
            continue
        calc = flow.evaluation_source(graph, node_id)
        if calc:
            out.append((node_id, calc))
    return out


def step_one_changed(camera: str, graph: dict) -> bool:
    """Whether a step-1 Freeze would now pick other pictures than in its newest freeze."""
    for node_id, node in graph["nodes"].items():
        if flow.kind_of(node_id) == "export" and flow.step_of(node) == 1:
            latest = export_box.state(camera, node_id).get("latest") or {}
            if latest.get("changed"):
                return True
    return False


def summary(camera: str, feature: str) -> dict:
    """Whether the viewer offers the drawing, how many Evaluations it would draw, and whether step 1 changed since its freeze."""
    if not available(camera, feature):
        return {"available": False, "evaluations": 0, "changed": False}
    graph = flow.load_graph(camera)
    found = evaluations(graph)
    return {"available": bool(found), "evaluations": len(found), "changed": bool(found) and step_one_changed(camera, graph)}


def frame_measures(camera: str, feature: str, frame: str) -> list[dict]:
    """What to draw on one picture: per step-1 Evaluation that judged it, the rule and the boxes A and B (whole picture,
    as stored: the centre pixel's index; ``None`` when not found). An Evaluation that does not see the picture (muted
    before its Calculate, outside its scope) is left out."""
    if not available(camera, feature):
        return []
    graph = flow.load_graph(camera)
    out = []
    for eval_id, calc_id in evaluations(graph):
        state = flow.evaluation_state(camera, eval_id)
        verdict = state["verdicts"].get(frame)
        if verdict is None:
            continue
        a, b = flow.effective_points(graph, calc_id)
        if a is None or b is None:
            continue
        keys = flow.point_keys(graph, calc_id)
        boxes = flow.whole_picture_boxes(camera, graph, {"a": keys[a], "b": keys[b]}, frame).get(frame, {})
        node, calc = graph["nodes"][eval_id], graph["nodes"][calc_id]
        out.append({
            "evaluation": eval_id,
            "mode": state["mode"],
            "op": calc["op"],
            "clockwise": bool(calc.get("clockwise", False)),
            "zone": flow.zone_of(node),
            "nominal": node.get("nominal"),
            "tolerance": node.get("tolerance", 0.0),
            "unit": state.get("unit", ""),
            "verdict": verdict,
            "a": boxes.get("a"),
            "b": boxes.get("b"),
        })
    return out
