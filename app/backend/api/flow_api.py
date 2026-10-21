"""Measurement flow on the chain: detector, Calculate and Evaluation boxes (see ``flow.py``). Thin router."""
from __future__ import annotations

import json

import anchor
import roi_input
import cv2
import flow
from api import jobs
from api.cameras import require_camera, require_feature
from fastapi import APIRouter, HTTPException, Response
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
    point: str | None = None  # detector -> Calculate: the one target the arrow carries (none = the whole detector)


class TargetBody(BaseModel):
    name: str
    inside: str | None = None  # a cascaded detector: the input detector's target whose box this one searches in


class TargetInsideBody(BaseModel):
    inside: str | None = None


class TargetOutputsBody(BaseModel):
    outputs: list[str]


class ExampleBody(BaseModel):
    target: str
    frame: str
    box: list[float]
    angle: float = 0.0  # the rectangle is turned by this many degrees (counter-clockwise on screen) and cut upright


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
    anchor.drop_for_detector(camera, node_id)  # a ROI anchored to it goes back to its static rectangle
    roi_input.drop_for_box(camera, node_id)  # and a ROI that read this box reads the whole picture again
    return {"removed": node_id}


@router.post("/cameras/{camera}/flow/edges", status_code=201)
def add_edge(camera: str, body: EdgeBody) -> dict:
    require_camera(camera)
    _guard(flow.connect, camera, body.source, body.target, body.point)
    return {"source": body.source, "target": body.target}


@router.post("/cameras/{camera}/flow/edges/remove")
def remove_edge(camera: str, body: EdgeBody) -> dict:
    require_camera(camera)
    _guard(flow.disconnect, camera, body.source, body.target, body.point)
    return {"source": body.source, "target": body.target}


@router.post("/cameras/{camera}/flow/nodes/{node_id}/targets", status_code=201)
def add_target(camera: str, node_id: str, body: TargetBody) -> dict:
    _known(camera, node_id)
    _guard(flow.add_target, camera, node_id, body.name, body.inside)
    return flow.node_detail(camera, node_id)


@router.put("/cameras/{camera}/flow/nodes/{node_id}/targets/{name}")
def set_target(camera: str, node_id: str, name: str, body: TargetInsideBody) -> dict:
    """Change which target of the input detector this target searches inside."""
    _known(camera, node_id)
    _guard(flow.set_target_inside, camera, node_id, name, body.inside)
    return flow.node_detail(camera, node_id)


@router.put("/cameras/{camera}/flow/nodes/{node_id}/targets/{name}/outputs")
def set_target_outputs(camera: str, node_id: str, name: str, body: TargetOutputsBody) -> dict:
    """Which outputs (position, angle, size) this target offers to the boxes its line feeds."""
    _known(camera, node_id)
    _guard(flow.set_target_outputs, camera, node_id, name, body.outputs)
    return flow.node_detail(camera, node_id)


@router.delete("/cameras/{camera}/flow/nodes/{node_id}/targets/{name}")
def remove_target(camera: str, node_id: str, name: str) -> dict:
    _known(camera, node_id)
    flow.remove_target(camera, node_id, name)
    anchor.drop_for_detector(camera, node_id, name)
    return flow.node_detail(camera, node_id)


@router.post("/cameras/{camera}/flow/nodes/{node_id}/examples", status_code=201)
def add_example(camera: str, node_id: str, body: ExampleBody) -> dict:
    _known(camera, node_id)
    _guard(flow.add_example, camera, node_id, body.target, body.frame, body.box, body.angle)
    return flow.node_detail(camera, node_id)


class ExampleBoxBody(BaseModel):
    box: list[float]
    angle: float | None = None  # none = keep the example's turn


@router.put("/cameras/{camera}/flow/nodes/{node_id}/examples/{target}/{index}")
def update_example(camera: str, node_id: str, target: str, index: int, body: ExampleBoxBody) -> dict:
    _known(camera, node_id)
    _guard(flow.update_example, camera, node_id, target, index, body.box, body.angle)
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


@router.get("/cameras/{camera}/flow/nodes/{node_id}/picture")
def get_picture(camera: str, node_id: str, frame: str, stage: str = "input", size: int | None = None, straighten: bool = False,
                step: str | None = None, steps: str | None = None) -> Response:
    """The picture a box works on (``stage=input``), or - for a Picture Edits box - the picture it passes on (``output``).
    ``step`` is one edit of that box: ``input`` is the picture entering it, ``output`` the one leaving it. ``steps`` (JSON)
    is a list of edits not saved yet, read in place of the box's own (the live preview). ``size`` gives a JPEG thumbnail
    whose longer side is that many pixels; without it a PNG at full size."""
    _known(camera, node_id)
    if stage not in ("input", "output"):
        raise HTTPException(status_code=422, detail="stage must be input or output")
    draft = None
    if steps is not None:
        try:
            draft = json.loads(steps)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="steps must be JSON") from exc
    image = _guard(flow.picture, camera, node_id, frame, stage, straighten, step, draft)
    if size:
        scale = min(1.0, max(16, min(size, 1024)) / max(image.shape[:2]))
        if scale < 1.0:
            image = cv2.resize(image, (max(1, round(image.shape[1] * scale)), max(1, round(image.shape[0] * scale))), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
        media = "image/jpeg"
    else:
        ok, buf = cv2.imencode(".png", image)
        media = "image/png"
    if not ok:
        raise HTTPException(status_code=415, detail="Cannot encode the picture.")
    return Response(content=buf.tobytes(), media_type=media, headers={"Cache-Control": "no-cache"})


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
    """Per-frame measured number (Calculate) or value + verdict (Evaluation), by frame name."""
    _known(camera, node_id)
    graph = flow.load_graph(camera)
    kind = graph["nodes"][node_id]["kind"]
    if kind == "evaluation":
        return flow.evaluation_state(camera, node_id)
    if kind == "calc":
        import labels  # noqa: PLC0415

        by_key = flow.calc_values(camera, node_id, graph)
        hmap = labels.hash_map(camera)
        return {"values": {f: by_key[hmap[f]] for f in flow._live_frames(camera) if hmap.get(f) in by_key}}
    raise HTTPException(status_code=422, detail="A detector has boxes, not values.")


@router.get("/cameras/{camera}/flow/opinions/{feature:path}")
def opinions(camera: str, feature: str) -> dict:
    """The Evaluation boxes arrowed into this feature's Classify box: value and pass / fail / undetermined by frame."""
    require_feature(camera, feature)
    return flow.feature_opinions(camera, feature)
