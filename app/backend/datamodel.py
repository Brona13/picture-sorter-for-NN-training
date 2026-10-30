"""Filesystem layout helpers: cameras, features, ROIs, image listing.

Layout (see the plan / docs/methodology.md)::

    cameras/<camera>/
        unsorted/          the camera's immutable frame store (every ingested frame)
        exports/           materialised training folders, per version

ROI geometry, labels, per-class golden *marks*, versions and the score cache
all live in SQLite (``data/picture_sorter.db``) — see ``db.py`` / ``labels.py``.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Callable, Iterator, TypeVar

import applog
import config
import db
import perf
import samples
from roi import ROI


_T = TypeVar("_T")
_render_cache: ContextVar[dict | None] = ContextVar(
    "datamodel_render_cache", default=None
)


@contextmanager
def render_snapshot() -> Iterator[None]:
    """Memoize immutable/read-only domain snapshots for one view render."""
    if _render_cache.get() is not None:
        yield
        return
    token = _render_cache.set({})
    try:
        yield
    finally:
        _render_cache.reset(token)


def _snapshot_value(key: tuple, loader: Callable[[], _T]) -> _T:
    cache = _render_cache.get()
    if cache is None:
        return loader()
    if key in cache:
        perf.count("render_snapshot.hits")
        perf.count(f"render_snapshot.{key[0]}.hits")
        return cache[key]
    perf.count("render_snapshot.misses")
    perf.count(f"render_snapshot.{key[0]}.misses")
    value = loader()
    cache[key] = value
    return value


def _invalidate_snapshot(camera: str, categories: set[str]) -> None:
    cache = _render_cache.get()
    if cache is None:
        return
    for key in list(cache):
        if key[0] in categories and (len(key) < 2 or key[1] == camera):
            cache.pop(key, None)


def invalidate_frames(camera: str) -> None:
    """Invalidate frame and product-scope snapshots after ingest."""
    _invalidate_snapshot(
        camera, {"unsorted", "unsorted_files", "product_membership", "product_frames", "feature_frames"}
    )


def invalidate_product_membership(camera: str) -> None:
    """Invalidate derived product and feature frame scopes after label changes."""
    _invalidate_snapshot(
        camera, {"product_membership", "product_frames", "feature_frames"}
    )


def invalidate_rois(camera: str) -> None:
    """Invalidate ROI-derived snapshots after create, edit, scope, or delete."""
    _invalidate_snapshot(
        camera, {"rois", "product_membership", "product_frames", "feature_frames"}
    )


# --- path helpers ------------------------------------------------------------
def camera_dir(camera: str) -> Path:
    return config.CAMERAS_ROOT / camera


def unsorted_dir(camera: str) -> Path:
    return camera_dir(camera) / config.UNSORTED_DIRNAME


def disk_usage(camera: str) -> dict[str, int]:
    """Files and bytes under the camera's folder (pictures and exports)."""
    files = size = 0
    for path in camera_dir(camera).rglob("*"):
        if path.is_file():
            files += 1
            size += path.stat().st_size
    return {"files": files, "bytes": size}


def delete_camera(camera: str) -> dict:
    """Remove a camera completely: its database rows and its folder (pictures and exports). Irreversible.

    The database goes first, in one transaction. If removing the folder then fails, the camera is still listed and
    the delete can simply be repeated.
    """
    import shutil

    folder = camera_dir(camera)
    if folder.parent.resolve() != config.CAMERAS_ROOT.resolve():
        raise ValueError(f"Not a camera folder: {camera}")
    usage = disk_usage(camera)
    rows = db.delete_camera_rows(camera)
    if folder.is_symlink():
        folder.unlink()
    else:
        shutil.rmtree(folder)
    _forget_camera(camera)
    return {"rows": rows, **usage}


def _forget_camera(camera: str) -> None:
    """Drop every in-memory snapshot of the camera and the thumbnail caches."""
    _invalidate_snapshot(camera, {"cameras", "unsorted", "rois", "product_membership", "product_frames", "feature_frames"})
    import thumbs

    thumbs._cached_thumb_data_uri.cache_clear()
    thumbs._cached_cutout_thumb.cache_clear()


# --- enumeration -------------------------------------------------------------
def list_cameras() -> list[str]:
    def load():
        root = config.CAMERAS_ROOT
        if not root.exists():
            return []
        perf.count("filesystem.camera_scans")
        with perf.span("filesystem.list_cameras"):
            return sorted(p.name for p in root.iterdir() if p.is_dir())

    return _snapshot_value(("cameras", str(config.CAMERAS_ROOT)), load)


def _list_images(directory: Path) -> list[Path]:
    if not directory.exists():
        return []
    return sorted(
        p
        for p in directory.iterdir()
        if p.is_file() and p.suffix.lower() in config.IMAGE_EXTENSIONS
    )


def list_unsorted(camera: str, *, include_removed: bool = False) -> list[Path]:
    """The camera's pictures. Pictures removed at Ingest are left out everywhere unless ``include_removed``."""

    def load():
        perf.count("filesystem.unsorted_scans")
        with perf.span("filesystem.list_unsorted"):
            return _list_images(unsorted_dir(camera))

    def load_in_use():
        removed = db.removed_frames_of(camera)
        files = _snapshot_value(("unsorted_files", camera), load)
        return [p for p in files if p.name not in removed] if removed else files

    if include_removed:
        return _snapshot_value(("unsorted_files", camera), load)
    return _snapshot_value(("unsorted", camera), load_in_use)


# --- ROIs / features ---------------------------------------------------------
def load_rois(camera: str) -> list[ROI]:
    def load():
        perf.count("roi.db_reads")
        with perf.span("roi.load_definitions"):
            return [ROI.from_dict(entry) for entry in db.list_rois(camera)]

    return _snapshot_value(("rois", camera), load)


def save_rois(camera: str, rois: list[ROI]) -> None:
    db.replace_rois(camera, [r.to_dict() for r in rois])
    invalidate_rois(camera)


def delete_roi(camera: str, feature: str) -> bool:
    """Remove one ROI definition; associated SQLite state is purged separately."""
    if not db.delete_roi_row(camera, feature):
        return False
    invalidate_rois(camera)
    return True


def get_roi(camera: str, feature: str) -> ROI | None:
    """Return the ROI named ``feature`` for ``camera``, or ``None``."""
    for r in load_rois(camera):
        if r.name == feature:
            return r
    return None


def list_features(camera: str) -> list[str]:
    """Feature names = ROI names defined for the camera."""
    return [r.name for r in load_rois(camera)]


# --- classes & frame scoping (multi-product hierarchy) -----------------------
# A ROI can be a product *classifier* (``role="classify"``, classes = product
# names) or a *quality* ROI (OK/NG). Quality ROIs that live under a product use
# a composite feature name ``"<product>::<roi>"`` so the whole (camera, feature)
# storage stack scopes them per product with no schema change.
FEATURE_SEP = "::"


def compose_feature(product: str | None, name: str) -> str:
    """``("typeA", "rod") -> "typeA::rod"``; a falsy product returns ``name`` unchanged."""
    return f"{product}{FEATURE_SEP}{name}" if product else name


def split_feature(feature: str) -> tuple[str | None, str]:
    """Inverse of :func:`compose_feature` — ``(product | None, short_name)``."""
    if FEATURE_SEP in feature:
        product, name = feature.split(FEATURE_SEP, 1)
        return product, name
    return None, feature


def classify_feature(camera: str) -> str | None:
    """Name of the camera's product-classification ROI, or ``None`` if none defined."""
    for r in load_rois(camera):
        if r.role == "classify":
            return r.name
    return None


def classes_for(camera: str, feature: str) -> list[str]:
    """The class vocabulary for a feature: the ROI's own ``classes`` if set,
    otherwise the project default (``config.CLASSES`` = OK/NG)."""
    roi = get_roi(camera, feature)
    if roi is not None and roi.classes:
        return list(roi.classes)
    return list(config.CLASSES)


def products(camera: str) -> list[str]:
    """The camera's product names = the classification ROI's classes (empty if none)."""
    cf = classify_feature(camera)
    return classes_for(camera, cf) if cf else []


def feature_products(camera: str, feature: str) -> list[str] | None:
    """Products a **shared** camera-level ROI applies to, or ``None`` if unrestricted."""
    roi = get_roi(camera, feature)
    return list(roi.products) if roi is not None and roi.products else None


def is_shared_feature(camera: str, feature: str) -> bool:
    """True for a camera-level ROI explicitly shared across a subset of products."""
    return split_feature(feature)[0] is None and feature_products(camera, feature) is not None


def list_features_for(camera: str, product: str | None = None) -> list[str]:
    """Full feature names visible in one scope.

    ``product=None`` gives the camera-level features (the classification ROI plus
    any camera-wide quality ROIs); a product name gives that product's own ROIs
    **plus any shared ROI that lists this product** — the shared one is the same
    feature in every scope, so it keeps a single golden/label set.
    """
    out: list[str] = []
    for r in load_rois(camera):
        owner = split_feature(r.name)[0]
        if owner == product:
            out.append(r.name)
        elif (
            owner is None
            and product is not None
            and r.role != "classify"
            and r.products
            and product in r.products
        ):
            out.append(r.name)
    return out


def _product_membership(camera: str) -> tuple[list[str], dict[str, set[str]]] | None:
    def load():
        perf.count("product.membership_builds")
        all_frames = [path.name for path in list_unsorted(camera)]
        cf = classify_feature(camera)
        if not cf:
            return None
        import labels  # lazy: labels imports datamodel

        labelled = labels.current_labels(camera, cf)
        membership: dict[str, set[str]] = {}
        for frame in all_frames:
            cls = labelled.get(frame)
            if cls:
                membership.setdefault(cls, set()).add(frame)
        return all_frames, membership

    return _snapshot_value(("product_membership", camera), load)


def frames_of_product(camera: str, product: str | None) -> list[str]:
    """Frames belonging to ``product`` according to the classification feature.

    A frame belongs to the product identified by its current product label.
    Golden/label consistency is enforced transactionally by ``labels.py``.

    ``product=None`` or a camera without a classification ROI returns the complete
    frame store.
    """
    if not product:
        return [path.name for path in list_unsorted(camera)]

    def load():
        snapshot = _product_membership(camera)
        if snapshot is None:
            return [path.name for path in list_unsorted(camera)]
        all_frames, membership = snapshot
        allowed = membership.get(product, set())
        return [frame for frame in all_frames if frame in allowed]

    return _snapshot_value(("product_frames", camera, product), load)


_resolving: ContextVar[frozenset] = ContextVar("datamodel_input_scope", default=frozenset())


@applog.timed("datamodel.input_scope")
def _input_scope(camera: str, feature: str) -> set[str] | None:
    """The pictures the line into a Classifier gives it, or ``None`` when no line restricts it.

    A line into a Classifier hands over exactly what the box on the other end passes on (``flow.node_frames``): the
    detector it is anchored to, the Picture edits box it reads, the Dedup box it reads through. Deleted pictures stay in
    (the callers filter them, as for every feature). A Classifier whose own dot feeds the box it reads (a loop) is not
    restricted by that line."""
    if feature == config.WHOLE_FRAME_FEATURE or feature.startswith("dedup:") or (camera, feature) in _resolving.get():
        return None
    import anchor  # noqa: PLC0415  (these import this module)
    import class_lines  # noqa: PLC0415
    import dedup_box  # noqa: PLC0415
    import flow  # noqa: PLC0415
    import roi_input  # noqa: PLC0415

    boxes = []
    spec = anchor.get_anchor(camera, feature)
    if spec:
        boxes.append(spec["detector"])
    spec = roi_input.get_input(camera, feature)
    if spec:
        boxes.append(spec["box"])
    dedup = dedup_box.input_of(camera, feature)
    if dedup:
        boxes.append(dedup)
    graph = flow.load_graph(camera)
    token = _resolving.set(_resolving.get() | {(camera, feature)})
    try:
        scope: set[str] | None = class_lines.scope(camera, feature)  # what the class dots give; None without lines into them
        wired = scope is not None
        for box in boxes:
            if box not in graph["nodes"]:
                continue  # a stale setting of a box that is gone
            wired = True
            given = set(flow.node_frames(camera, box, graph))
            scope = given if scope is None else scope & given
    finally:
        _resolving.reset(token)
    if not wired and _reads_nothing(camera, feature):
        return set()  # no line into it, so no pictures: nothing is assumed in the background
    return None if scope is None else scope | db.deleted_frames_of(camera)


def _reads_nothing(camera: str, feature: str) -> bool:
    """A plain Classifier whose line from Ingest was never drawn, or was deleted, has no input. (A product's feature and a
    Classifier shared across products are fed by the dots of the product-sorting Classifier, so they always have a line.)"""
    if split_feature(feature)[0] is not None or feature_products(camera, feature):
        return False
    return db.get_setting(camera, f"{db.DETACHED_KEY}{feature}") == "1"


@applog.timed("datamodel.frames_for_feature")
def frames_for_feature(camera: str, feature: str) -> list[str]:
    """Frame filenames this feature applies to.

    A product-scoped feature ``"<product>::<roi>"`` sees only that product's
    frames — the nesting's "teeth". A **shared** camera-level ROI sees the union
    of the products it lists. Everything else sees the whole inbox. A Classifier
    fed by a line from a detector, Picture edits or Dedup box sees only what that
    line gives it (``_input_scope``), on top of the rules above.
    """
    def load():
        scope = _input_scope(camera, feature)

        def narrow(files: list[str]) -> list[str]:
            return files if scope is None else [f for f in files if f in scope]

        product = split_feature(feature)[0]
        if product:
            return _as_samples(camera, feature, narrow(frames_of_product(camera, product)))

        shared = feature_products(camera, feature)
        if shared:
            allowed = set()
            for selected_product in shared:
                allowed.update(frames_of_product(camera, selected_product))
            # keep the inbox order rather than the products' order
            return _as_samples(camera, feature, narrow([
                frame for frame in frames_of_product(camera, None)
                if frame in allowed
            ]))

        return _as_samples(camera, feature, narrow(frames_of_product(camera, None)))

    return _snapshot_value(("feature_frames", camera, feature), load)


def _as_samples(camera: str, feature: str, files: list[str]) -> list[str]:
    """A Classifier anchored on a detector target that looks for several elements works on one sample per found box
    (``part.png#2``, see ``samples.py``) instead of one per picture; every other feature keeps its pictures."""
    import anchor  # noqa: PLC0415  (anchor imports this module)
    import flow  # noqa: PLC0415

    if feature == config.WHOLE_FRAME_FEATURE or feature.startswith("dedup:"):
        return files
    spec = anchor.get_anchor(camera, feature)
    slots = anchor.group_slots(camera, spec) if spec else None
    if not slots:
        return files
    stored = flow.load_stored(camera, spec["detector"])["frames"]
    hashes = db.frame_hash_map(camera)
    out: list[str] = []
    for frame in files:
        found = stored.get(hashes.get(frame, ""), {})
        out.extend(samples.make(frame, i) for i, slot in enumerate(slots, 1) if slot in found)
    return out


def ensure_camera_dirs(camera: str) -> None:
    unsorted_dir(camera).mkdir(parents=True, exist_ok=True)
    cache = _render_cache.get()
    if cache is not None:
        for key in list(cache):
            if key[0] == "cameras":
                cache.pop(key, None)
