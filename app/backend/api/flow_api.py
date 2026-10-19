"""Measurement flow on the chain: detector, Calculate and Tolerance boxes (see ``flow.py``). Thin router."""
from __future__ import annotations

import flow
from api import jobs
from api.cameras import require_camera, require_feature
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except flow.FlowError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class NodeCreate(BaseModel):
    kind: str


class EdgeBody(BaseModel):
    source: str
    target: str


class TargetBody(BaseModel):
    name: str


class ExampleBody(BaseModel):
    target: str
    frame: str
    box: list[float]


class BoxBody(BaseModel):
    frame: str
    target: str
    x: float
    y: float
    angle: float | None = None


def _known(camera: str, node_id: str) -> None:
    require_camera(camera)
    if node_id not in flow.load_graph(camera)["nodes"]:
        raise HTTPException(status_code=404, detail=f"Unknown box: {node_id}")


@router.post("/cameras/{camera}/flow/nodes", status_code=201)
def create_node(camera: str, body: NodeCreate) -> dict:
    require_camera(camera)
    node_id = _guard(flow.create_node, camera, body.kind)
    return {"id": node_id}


@router.get("/cameras/{camera}/flow/nodes/{node_id}")
def get_node(camera: str, node_id: str) -> dict:
    _known(camera, node_id)
    return flow.node_detail(camera, node_id)


@router.put("/cameras/{camera}/flow/nodes/{node_id}")
def put_node(camera: str, node_id: str, body: dict) -> dict:
    _known(camera, node_id)
    _guard(flow.update_node, camera, node_id, body)
    return flow.node_detail(camera, node_id)


@router.get("/cameras/{camera}/flow/nodes/{node_id}/delete-preview")
def delete_preview(camera: str, node_id: str) -> dict:
    _known(camera, node_id)
    return flow.delete_preview(camera, node_id)


@router.delete("/cameras/{camera}/flow/nodes/{node_id}")
def delete_node(camera: str, node_id: str) -> dict:
    _known(camera, node_id)
    _guard(flow.delete_node, camera, node_id)
    return {"removed": node_id}


@router.post("/cameras/{camera}/flow/edges", status_code=201)
def add_edge(camera: str, body: EdgeBody) -> dict:
    require_camera(camera)
    _guard(flow.connect, camera, body.source, body.target)
    return {"source": body.source, "target": body.target}


@router.post("/cameras/{camera}/flow/edges/remove")
def remove_edge(camera: str, body: EdgeBody) -> dict:
    require_camera(camera)
    _guard(flow.disconnect, camera, body.source, body.target)
    return {"source": body.source, "target": body.target}


@router.post("/cameras/{camera}/flow/nodes/{node_id}/targets", status_code=201)
def add_target(camera: str, node_id: str, body: TargetBody) -> dict:
    _known(camera, node_id)
    _guard(flow.add_target, camera, node_id, body.name)
    return flow.node_detail(camera, node_id)


@router.delete("/cameras/{camera}/flow/nodes/{node_id}/targets/{name}")
def remove_target(camera: str, node_id: str, name: str) -> dict:
    _known(camera, node_id)
    flow.remove_target(camera, node_id, name)
    return flow.node_detail(camera, node_id)


@router.post("/cameras/{camera}/flow/nodes/{node_id}/examples", status_code=201)
def add_example(camera: str, node_id: str, body: ExampleBody) -> dict:
    _known(camera, node_id)
    _guard(flow.add_example, camera, node_id, body.target, body.frame, body.box)
    return flow.node_detail(camera, node_id)


class ExampleBoxBody(BaseModel):
    box: list[float]


@router.put("/cameras/{camera}/flow/nodes/{node_id}/examples/{target}/{index}")
def update_example(camera: str, node_id: str, target: str, index: int, body: ExampleBoxBody) -> dict:
    _known(camera, node_id)
    _guard(flow.update_example, camera, node_id, target, index, body.box)
    return flow.node_detail(camera, node_id)


@router.delete("/cameras/{camera}/flow/nodes/{node_id}/examples/{target}/{index}")
def remove_example(camera: str, node_id: str, target: str, index: int) -> dict:
    _known(camera, node_id)
    _guard(flow.remove_example, camera, node_id, target, index)
    return flow.node_detail(camera, node_id)


@router.post("/cameras/{camera}/flow/nodes/{node_id}/run", status_code=202)
def run_detector(camera: str, node_id: str) -> dict:
    """Search every live frame with this detector (a background job)."""
    _known(camera, node_id)
    graph = flow.load_graph(camera)
    if graph["nodes"][node_id]["kind"] != "detector":
        raise HTTPException(status_code=422, detail="Only a detector can be run.")

    def work(report):
        return flow.run_detector(camera, node_id, report)

    return jobs.registry.submit("flow_detect", camera, work).to_dict()


@router.post("/cameras/{camera}/flow/run", status_code=202)
def run_all(camera: str) -> dict:
    """Run every detector, inputs first (a background job)."""
    require_camera(camera)

    def work(report):
        return flow.run_all(camera, report)

    return jobs.registry.submit("flow_detect", camera, work).to_dict()


@router.get("/cameras/{camera}/flow/nodes/{node_id}/boxes")
def get_boxes(camera: str, node_id: str, only_review: bool = False) -> dict:
    """Boxes found by a detector, by frame name; ``only_review`` lists just the frames with a missing target."""
    _known(camera, node_id)
    boxes = flow.frame_boxes(camera, node_id)
    review = flow.review_frames(camera, node_id)
    if only_review:
        boxes = {f: boxes[f] for f in review}
    return {"boxes": boxes, "review": review}


@router.put("/cameras/{camera}/flow/nodes/{node_id}/box")
def put_box(camera: str, node_id: str, body: BoxBody) -> dict:
    _known(camera, node_id)
    return _guard(flow.set_box, camera, node_id, body.frame, body.target, body.x, body.y, body.angle)


@router.get("/cameras/{camera}/flow/nodes/{node_id}/values")
def get_values(camera: str, node_id: str) -> dict:
    """Per-frame measured number (Calculate) or value + verdict (Tolerance), by frame name."""
    _known(camera, node_id)
    graph = flow.load_graph(camera)
    kind = graph["nodes"][node_id]["kind"]
    if kind == "tolerance":
        return flow.tolerance_state(camera, node_id)
    if kind == "calc":
        import labels  # noqa: PLC0415

        by_key = flow.calc_values(camera, node_id, graph)
        hmap = labels.hash_map(camera)
        return {"values": {f: by_key[hmap[f]] for f in flow._live_frames(camera) if hmap.get(f) in by_key}}
    raise HTTPException(status_code=422, detail="A detector has boxes, not values.")


@router.get("/cameras/{camera}/flow/opinions/{feature:path}")
def opinions(camera: str, feature: str) -> dict:
    """The Tolerance boxes arrowed into this feature's Classify box: value and pass / fail / undetermined by frame."""
    require_feature(camera, feature)
    return flow.feature_opinions(camera, feature)
