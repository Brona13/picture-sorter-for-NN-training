"""ROI (feature) CRUD for the editor: list, add/update, move, share, delete, products."""
from __future__ import annotations

import anchor
import roi_input
import samples
import config
import datamodel
import db
import dedup_box
import engine
import flow
import labels
import products as product_admin
import versions
from api.cameras import require_camera
from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel
from roi import ROI

router = APIRouter()
_EPS = 1e-6


class Box(BaseModel):
    x: float
    y: float
    w: float
    h: float


class RoiUpsert(Box):
    name: str
    product: str | None = None
    make_classifier: bool = False
    product_names: list[str] = []
    shared_with: list[str] = []


class ProductsUpdate(BaseModel):
    products: list[str]


class ClassNamesUpdate(BaseModel):
    #: The products as they should be afterwards (new names for the renamed ones), in order.
    names: list[str]
    #: Old name -> new name for the products that are renamed: their labels, goldens and ROIs go along.
    renames: dict[str, str] = {}


def _check_box(b: Box) -> None:
    if not (0 <= b.x <= 1 and 0 <= b.y <= 1 and b.w > 0 and b.h > 0):
        raise HTTPException(status_code=422, detail="Box must be inside the frame (0-1).")
    if b.x + b.w > 1 + _EPS or b.y + b.h > 1 + _EPS:
        raise HTTPException(status_code=422, detail="Box extends beyond the frame.")


def _require_roi(camera: str, feature: str) -> ROI:
    require_camera(camera)
    roi = datamodel.get_roi(camera, feature)
    if roi is None:
        raise HTTPException(status_code=404, detail=f"Unknown ROI: {feature}")
    return roi


def _describe(camera: str, r: ROI, inbox_total: int) -> dict:
    owner, short = datamodel.split_feature(r.name)
    classes = datamodel.classes_for(camera, r.name)
    counts = labels.counts(camera, r.name)
    vl = [v for v in versions.list_versions(camera, r.name) if v["deleted"] is None]
    active = next((v["number"] for v in vl if v["active"]), None)
    return {
        "feature": r.name,
        "short_name": short,
        "owner_product": owner,
        "role": r.role,
        "classes": classes,
        "shared_products": list(r.products) if r.products else None,
        "x": r.x,
        "y": r.y,
        "w": r.w,
        "h": r.h,
        "frames_seen": counts.get("total", 0),
        "inbox_total": inbox_total,
        "labeled": sum(counts.get(c, 0) for c in classes),
        "goldens": sum(counts.get(f"golden_{c}", 0) for c in classes),
        "version_count": len(vl),
        "active_version": active,
        "anchored": anchor.get_anchor(camera, r.name) is not None,
        "input": (roi_input.get_input(camera, r.name) or {}).get("box"),
    }


@router.get("/cameras/{camera}/rois")
def list_rois(camera: str, product: str | None = None) -> dict:
    """ROIs in one scope (``product`` or camera level) plus editor context."""
    require_camera(camera)
    products = datamodel.products(camera)
    if product is not None and product not in products:
        raise HTTPException(status_code=404, detail=f"Unknown product: {product}")
    with datamodel.render_snapshot():
        all_rois = datamodel.load_rois(camera)
        inbox_total = len(datamodel.list_unsorted(camera))
        in_scope = [r for r in all_rois if datamodel.split_feature(r.name)[0] == product]
        assigned: set[str] = set()
        for p in products:
            assigned.update(datamodel.frames_of_product(camera, p))
        shared_here = [
            r.name
            for r in all_rois
            if product
            and datamodel.split_feature(r.name)[0] is None
            and r.role != "classify"
            and r.products
            and product in r.products
        ]
        return {
            "rois": [_describe(camera, r, inbox_total) for r in in_scope],
            "classify_feature": datamodel.classify_feature(camera),
            "products": products,
            "inbox_total": inbox_total,
            "unclassified_frames": (inbox_total - len(assigned)) if products else 0,
            "shared_here": shared_here,
        }


@router.put("/cameras/{camera}/rois")
def upsert_roi(camera: str, body: RoiUpsert) -> dict:
    """Add a ROI, or replace the same-named one (mirrors the old 'Add / update ROI')."""
    require_camera(camera)
    _check_box(body)
    short = body.name.strip()
    products = datamodel.products(camera)
    classify_feat = datamodel.classify_feature(camera)
    if not short:
        raise HTTPException(status_code=422, detail="Please enter a feature name.")
    if "/" in short or "\\" in short:
        raise HTTPException(status_code=422, detail="ROI names cannot contain slashes.")
    if short.startswith("@"):
        raise HTTPException(status_code=422, detail="ROI names cannot start with @ (reserved).")
    if datamodel.FEATURE_SEP in short:
        raise HTTPException(status_code=422, detail=f"`{datamodel.FEATURE_SEP}` is reserved — please pick a name without it.")
    if body.product is not None and body.product not in products:
        raise HTTPException(status_code=404, detail=f"Unknown product: {body.product}")
    new_products = [p.strip() for p in body.product_names if p.strip()]
    if body.make_classifier:
        if body.product is not None or classify_feat is not None:
            raise HTTPException(status_code=422, detail="Only one product-sorting ROI is allowed, at camera level.")
        if len(new_products) < 2:
            raise HTTPException(status_code=422, detail="A product-sorting ROI needs at least two product names.")
    shared = [p for p in body.shared_with if p]
    unknown = [p for p in shared if p not in products]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown products: {', '.join(unknown)}")
    if shared and body.product is not None:
        raise HTTPException(status_code=422, detail="Only camera-level ROIs can be shared across products.")

    full = datamodel.compose_feature(body.product, short)
    existing = datamodel.get_roi(camera, full)
    if existing is not None and existing.role == "classify" and not body.make_classifier:
        raise HTTPException(status_code=422, detail="Cannot turn the product-sorting ROI into a quality ROI.")
    updated = [r for r in datamodel.load_rois(camera) if r.name != full]
    roi = ROI(
        full, body.x, body.y, body.w, body.h,
        role="classify" if body.make_classifier else "quality",
        classes=new_products if body.make_classifier else None,
        products=shared or None,
    )
    updated.append(roi)
    datamodel.save_rois(camera, updated)
    return _describe(camera, roi, len(datamodel.list_unsorted(camera)))


@router.patch("/cameras/{camera}/rois/{feature}/geometry")
def move_roi(camera: str, feature: str, body: Box) -> dict:
    """Move/resize only: labels and goldens keep their feature key."""
    _require_roi(camera, feature)
    _check_box(body)
    rois = datamodel.load_rois(camera)
    for r in rois:
        if r.name == feature:
            r.x, r.y, r.w, r.h = body.x, body.y, body.w, body.h
            moved = r
    datamodel.save_rois(camera, rois)
    return _describe(camera, moved, len(datamodel.list_unsorted(camera)))


@router.patch("/cameras/{camera}/rois/{feature}/products")
def set_applies_to(camera: str, feature: str, body: ProductsUpdate) -> dict:
    roi = _require_roi(camera, feature)
    if roi.role == "classify" or datamodel.split_feature(feature)[0] is not None:
        raise HTTPException(status_code=422, detail="Only camera-level quality ROIs can be shared across products.")
    unknown = [p for p in body.products if p not in datamodel.products(camera)]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown products: {', '.join(unknown)}")
    rois = datamodel.load_rois(camera)
    for r in rois:
        if r.name == feature:
            r.products = list(body.products) or None
            roi = r
    datamodel.save_rois(camera, rois)
    db.delete_setting(camera, f"{db.DETACHED_KEY}{feature}")  # a line from Ingest or a product dot is drawn again
    return _describe(camera, roi, len(datamodel.list_unsorted(camera)))


class AnchorBody(BaseModel):
    detector: str
    target: str
    mode: str = "box"  # box: the ROI is the found box plus a margin; rect: follows the rectangle drawn on `frame`
    margin: float = 0.1
    frame: str | None = None  # mode rect: the picture the rectangle is drawn on (the detector must have found the target there)
    follow_rotation: bool = False


@router.put("/cameras/{camera}/rois/{feature}/anchor")
def put_anchor(camera: str, feature: str, body: AnchorBody) -> dict:
    """Anchor the ROI to a detector's box: its rectangle then follows that box on every picture (see ``anchor.py``)."""
    _require_roi(camera, feature)
    try:
        return anchor.set_anchor(camera, feature, body.detector, body.target, body.frame, mode=body.mode,
                                 margin=body.margin, follow_rotation=body.follow_rotation)
    except (anchor.AnchorError, FileNotFoundError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/cameras/{camera}/rois/{feature}/anchor")
def get_anchor(camera: str, feature: str) -> dict:
    """The anchor of the ROI (or ``None``) and, in mode ``rect``, the example picture with the detector's found box in
    fractions of it: the ROI editor opens on that picture and draws the box as a reference."""
    _require_roi(camera, feature)
    spec = anchor.get_anchor(camera, feature)
    context = None
    if spec and spec["mode"] == "rect" and spec.get("frame"):
        try:
            box = anchor.found_box(camera, spec, spec["frame"])
        except OSError:
            box = None
        context = {"frame": spec["frame"], "box": box, "target": spec["target"]}
    return {"anchor": spec, "context": context}


@router.get("/cameras/{camera}/rois/{feature}/rect")
def roi_rect(camera: str, feature: str, frame: str) -> dict:
    """The rectangle of the ROI on one picture: its own, or - anchored - where the detector's box puts it (``rect`` is
    ``None`` when the detector found no box there)."""
    if dedup_box.is_box(feature):  # a Dedup box (v1.106.0): the box a detector found for its target, or the Picture edits box it reads
        require_camera(camera)
        edits = roi_input.get_input(camera, feature)
        extra = {"input": edits["box"] if edits else None, "box": True}
    else:
        _require_roi(camera, feature)
        extra = {}
    path = datamodel.unsorted_dir(camera) / samples.file_of(frame)  # a sample of a target with several elements: its file
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Unknown frame: {frame}")
    spec = anchor.get_anchor(camera, feature)
    if spec is None:
        r = engine.resolve_roi(camera, feature)
        return {"anchored": False, "rect": {"x": r.x, "y": r.y, "w": r.w, "h": r.h}, **extra}
    with Image.open(path) as picture:
        width, height = picture.size
    placed = engine.resolve_roi_for_frame(camera, feature, labels.hash_map(camera).get(frame, ""), width, height)
    return {"anchored": True, "rect": None if placed is None else {"x": placed.x, "y": placed.y, "w": placed.w, "h": placed.h}, **extra}


class InputBody(BaseModel):
    box: str


@router.put("/cameras/{camera}/rois/{feature}/input")
def put_input(camera: str, feature: str, body: InputBody) -> dict:
    """The ROI reads the picture a Picture edits box passes on (filters only; see ``roi_input.py``)."""
    _require_roi(camera, feature)
    try:
        return {"feature": feature, "input": roi_input.set_input(camera, feature, body.box)}
    except roi_input.RoiInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/cameras/{camera}/rois/{feature}/input")
def delete_input(camera: str, feature: str) -> dict:
    """Back to the whole, unedited picture."""
    _require_roi(camera, feature)
    roi_input.clear_input(camera, feature)
    return {"feature": feature, "input": None}


@router.delete("/cameras/{camera}/rois/{feature}/anchor")
def delete_anchor(camera: str, feature: str) -> dict:
    """Back to the static rectangle."""
    _require_roi(camera, feature)
    anchor.clear_anchor(camera, feature)
    return {"feature": feature, "anchor": None}


@router.delete("/cameras/{camera}/rois/{feature}")
def delete_roi(camera: str, feature: str) -> dict:
    """Delete the ROI and purge its labels, goldens, versions and caches (irreversible)."""
    _require_roi(camera, feature)
    datamodel.delete_roi(camera, feature)
    anchor.clear_anchor(camera, feature)
    roi_input.clear_input(camera, feature)
    flow.drop_classify_edges(camera, feature)
    return {"removed": labels.purge_feature(camera, feature)}


@router.put("/cameras/{camera}/product-names")
def set_product_names(camera: str, body: ClassNamesUpdate) -> dict:
    """Rename/add/remove the product classes of the product-sorting ROI."""
    require_camera(camera)
    classify_feat = datamodel.classify_feature(camera)
    if classify_feat is None:
        raise HTTPException(status_code=404, detail="This camera has no product-sorting ROI.")
    wanted = list(dict.fromkeys(p.strip() for p in body.names if p.strip()))
    if len(wanted) < 2:
        raise HTTPException(status_code=422, detail="Keep at least two products.")
    if body.renames:
        try:
            done = product_admin.check_renames(camera, body.renames)
            missing = [new for new in done.values() if new not in wanted]
            if missing:
                raise product_admin.ProductError(f"The renamed product {missing[0]} is not in the list of products.")
            product_admin.rename_products(camera, body.renames)
        except product_admin.ProductError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    rois = datamodel.load_rois(camera)
    for r in rois:
        if r.name == classify_feat:
            r.classes = wanted
    datamodel.save_rois(camera, rois)
    return {"products": datamodel.products(camera)}


class ModeUpdate(BaseModel):
    mode: str  # "product" or "feature"
    product_names: list[str] = []


@router.put("/cameras/{camera}/rois/{feature}/mode")
def set_mode(camera: str, feature: str, body: ModeUpdate) -> dict:
    """Switch one Classifier between Feature (OK / NG, labels one feature) and Product (its classes are the product names).

    The labels and goldens of that Classifier are cleared: their classes no longer exist. Both directions are refused while
    another Classifier depends on the product list (a camera has one Product Classifier)."""
    roi = _require_roi(camera, feature)
    if body.mode not in ("product", "feature"):
        raise HTTPException(status_code=422, detail="The mode is product or feature.")
    owner, _ = datamodel.split_feature(feature)
    if owner is not None:
        raise HTTPException(status_code=422, detail="A Classifier that belongs to a product by its name cannot change mode.")
    cleared = len(labels.current_labels(camera, feature))
    rois = datamodel.load_rois(camera)
    target = next(r for r in rois if r.name == feature)
    if body.mode == "product":
        if roi.role == "classify":
            raise HTTPException(status_code=422, detail="It is the Product Classifier already.")
        other = datamodel.classify_feature(camera)
        if other is not None:
            raise HTTPException(status_code=422, detail=f"{other} is the Product Classifier of this camera; a camera has one.")
        names = [n.strip() for n in body.product_names if n.strip()]
        if len(names) < 2 or len(set(names)) != len(names):
            raise HTTPException(status_code=422, detail="Give at least two different product names.")
        if any(datamodel.FEATURE_SEP in n for n in names):
            raise HTTPException(status_code=422, detail=f"`{datamodel.FEATURE_SEP}` is reserved — please pick names without it.")
        target.role, target.classes, target.products = "classify", names, None
    else:
        if roi.role != "classify":
            raise HTTPException(status_code=422, detail="It is a Feature Classifier already.")
        dependents = [r.name for r in rois if r.name != feature and (datamodel.split_feature(r.name)[0] is not None or r.products)]
        if dependents:
            raise HTTPException(status_code=422, detail=f"{', '.join(dependents)} depend on the products. Delete those lines or Classifiers first.")
        target.role, target.classes = "quality", None
    labels.clear_labels_bulk(camera, feature, list(labels.current_labels(camera, feature)))
    datamodel.save_rois(camera, rois)
    return {**_describe(camera, target, len(datamodel.list_unsorted(camera))), "cleared": cleared}
