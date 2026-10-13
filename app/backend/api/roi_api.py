"""ROI (feature) CRUD for the editor: list, add/update, move, share, delete, products."""
from __future__ import annotations

import config
import datamodel
import labels
import versions
from api.cameras import require_camera
from fastapi import APIRouter, HTTPException
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
    names: list[str]


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
    vl = versions.list_versions(camera, r.name)
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
    return _describe(camera, roi, len(datamodel.list_unsorted(camera)))


@router.delete("/cameras/{camera}/rois/{feature}")
def delete_roi(camera: str, feature: str) -> dict:
    """Delete the ROI and purge its labels, goldens, versions and caches (irreversible)."""
    _require_roi(camera, feature)
    datamodel.delete_roi(camera, feature)
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
    rois = datamodel.load_rois(camera)
    for r in rois:
        if r.name == classify_feat:
            r.classes = wanted
    datamodel.save_rois(camera, rois)
    return {"products": datamodel.products(camera)}
