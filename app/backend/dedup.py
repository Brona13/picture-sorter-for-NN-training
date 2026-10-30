"""Perceptual near-duplicate clustering on ROI-cutout embeddings.

DBSCAN on ResNet embeddings, per (camera, feature), independent of any golden
set. Frames grouped into a cluster share one representative (the one closest to
the cluster centroid, unless the user overrides it); the rest can be
soft-muted so the Classify view hides them.

Muting never touches source frames on disk and never mutes a golden (a Dedup box may mute a labeled frame)
frame. It's fully reversible via :func:`db.clear_dedup_mutes`.

See ``plans/curation-loop-enhancements.md`` (Phase 1) for the surrounding
design.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np

import classify
import datamodel
import db
import embedding
import engine
import labels
import applog

_log = applog.get("dedup")


DEFAULT_BACKBONE = "resnet50"
NOISE = -1  # DBSCAN's label for points that don't join any cluster


# --- results -----------------------------------------------------------------
@dataclass
class ClusterResult:
    """One clustering pass over a (camera, feature) frame set.

    ``labels_by_frame`` maps every scored frame to its cluster id (``NOISE`` for
    outliers). ``clusters`` orders real (non-noise) cluster ids by size, largest
    first. ``representatives`` maps each real cluster to the frame closest to
    its centroid (a first pick — the UI may override). ``embeddings`` holds the
    same NxD matrix DBSCAN was fit on, in ``frame_order`` order, so downstream
    consumers (e.g. the scatter view) don't have to re-fetch vectors.
    """
    method: str
    epsilon: float
    min_points: int
    labels_by_frame: dict[str, int]
    clusters: list[int]
    representatives: dict[int, str]
    frame_order: list[str]
    embeddings: np.ndarray

    def members(self, cluster_id: int) -> list[str]:
        """Frames in one cluster, in scoring order (deterministic)."""
        return [f for f in self.frame_order if self.labels_by_frame.get(f) == cluster_id]

    @property
    def noise_frames(self) -> list[str]:
        return [f for f, cid in self.labels_by_frame.items() if cid == NOISE]

    def muted_from_representatives(
        self, chosen: dict[int, str] | None = None,
    ) -> list[str]:
        """Frames the current pick would mute: every clustered frame *except* the
        chosen representative of its cluster. Noise frames are never muted."""
        pick = {**self.representatives, **(chosen or {})}
        out: list[str] = []
        for cid in self.clusters:
            rep = pick.get(cid, self.representatives.get(cid))
            for f in self.members(cid):
                if f != rep:
                    out.append(f)
        return out


# --- embedding fetch ---------------------------------------------------------
def fetch_embeddings(
    camera: str, feature: str, frames: list[str], backbone: str,
    progress_cb=None,
) -> tuple[list[str], np.ndarray]:
    """Load-or-compute one embedding vector per frame, reusing the classify
    score_cache. Returns (frame_names_in_order, NxD float32 matrix).

    Frames that can't be loaded (missing on disk, unreadable) are silently
    dropped from both outputs.
    """
    if backbone not in embedding.backbones():
        raise RuntimeError(
            f"Embedding backbone {backbone!r} is not available. "
            "Install torch+torchvision (see requirements-embedding.txt)."
        )
    roi = engine.resolve_roi(camera, feature)
    hmap = labels.hash_map(camera)

    con = db.connect()
    try:
        roi_key = classify._roi_cache_key(roi, camera, feature, con)
        vectors = classify.fetch_vectors(
            con,
            camera,
            feature,
            roi_key,
            roi,
            frames,
            hmap,
            [backbone],
            include_classical=False,
            progress_cb=progress_cb,
        )
    finally:
        con.close()

    kept = [frame for frame in frames if frame in vectors]
    vecs = [vectors[frame][backbone] for frame in kept]
    if not vecs:
        return kept, np.zeros((0, 0), dtype=np.float32)
    return kept, np.stack(vecs).astype(np.float32)


def live_frames(camera: str, feature: str) -> list[str]:
    """The feature's frames minus soft-deleted ones: what clustering and outlier scoring see."""
    import dedup_box  # noqa: PLC0415  (dedup_box reads the flow graph; it imports nothing from here)

    if dedup_box.is_box(feature):
        return dedup_box.frames(camera, feature)  # a Dedup box sees the whole camera or one dot of a Classifier
    deleted = db.deleted_frames_of(camera)
    return [f for f in datamodel.frames_for_feature(camera, feature) if f not in deleted]


# --- clustering --------------------------------------------------------------
def cluster(
    camera: str,
    feature: str,
    *,
    epsilon: float,
    min_points: int,
    method: str = DEFAULT_BACKBONE,
    progress_cb=None,
) -> ClusterResult:
    """Run DBSCAN over the feature's frame-set embeddings.

    ``epsilon`` is the cosine-distance neighborhood radius; the same [0, 1]
    space the ResNet scoring family uses. ``min_points`` is DBSCAN's core-point
    threshold (typical values 2–5). Soft-deleted frames are left out entirely.
    """
    kept, matrix = fetch_embeddings(camera, feature, live_frames(camera, feature), method, progress_cb)
    return cluster_matrix(kept, matrix, epsilon=epsilon, min_points=min_points, method=method)


# --- sweep: the clustering over a range of settings ---------------------------
PRECOMPUTE_MAX = 6000  # up to this many pictures the pairwise distances are computed once (N x N float32, 144 MB at 6000)


def sweep_epsilons(start: float, stop: float, step: float) -> list[float]:
    """The Epsilon values of a sweep: ``start`` to ``stop`` inclusive in ``step``s, rounded so 0.015 stays 0.015."""
    n = int(round((stop - start) / step + 1e-9))
    return [round(start + i * step, 6) for i in range(n + 1)]


def window_of(clusters: list[int], would_mute: list[int]) -> tuple[int, int] | None:
    """Where something happens, as indexes into the Epsilon list: from the first Epsilon where anything would be muted
    to the first one past the cluster-count peak where everything sits in one cluster (the last one when that never
    happens). None when nothing is ever muted."""
    start = next((i for i, m in enumerate(would_mute) if m > 0), None)
    if start is None:
        return None
    top = max(range(start, len(clusters)), key=lambda i: (clusters[i], -i))  # the first highest count
    end = next((i for i in range(top, len(clusters)) if clusters[i] <= 1), len(clusters) - 1)
    return start, end


def peak_of(lines: dict[int, dict[str, list[int | None]]], epsilons: list[float]) -> dict | None:
    """The setting with the most clusters over every line; a tie goes to the smaller Epsilon, then the smaller Min points."""
    best: tuple[int, float, int] | None = None
    for mp, line in lines.items():
        for eps, count in zip(epsilons, line["clusters"], strict=True):
            if count is None or count <= 0:
                continue
            if best is None or (count, -eps, -mp) > (best[0], -best[1], -best[2]):
                best = (count, eps, mp)
    return None if best is None else {"epsilon": best[1], "min_points": best[2], "clusters": best[0]}


def _counts(labels_: np.ndarray) -> tuple[int, int]:
    """(clusters, would mute) of one DBSCAN labelling; would mute = clustered pictures minus one representative per cluster,
    the same number the Clusters tool shows as "N frame(s) will be muted"."""
    top = int(labels_.max()) if labels_.size else -1
    if top < 0:
        return 0, 0
    clustered = int((labels_ >= 0).sum())
    return top + 1, clustered - (top + 1)


def sweep_matrix(
    matrix: np.ndarray, *, epsilons: list[float], min_points: list[int], progress_cb=None,
) -> dict:
    """Cluster ``matrix`` at every setting of a sweep and count the clusters and the pictures that would be muted.

    Round one runs the lowest Min points over every Epsilon and finds the window where something happens
    (:func:`window_of`); the other Min points run only inside that window, their lines are None outside it. The pairwise
    distances are computed once and every run reuses them (up to ``PRECOMPUTE_MAX`` pictures).
    """
    from sklearn.cluster import DBSCAN  # noqa: PLC0415  (optional dep, import lazily)
    from sklearn.metrics import pairwise_distances  # noqa: PLC0415

    mps = sorted(set(min_points))
    n = int(matrix.shape[0])
    lines: dict[int, dict[str, list[int | None]]] = {mp: {"clusters": [None] * len(epsilons), "would_mute": [None] * len(epsilons)} for mp in mps}
    total = len(epsilons) * len(mps)
    done = 0
    if n == 0:
        return {"epsilons": epsilons, "min_points": mps, "lines": lines, "window": None, "peak": None, "frames": 0}

    if n <= PRECOMPUTE_MAX:
        dist = np.clip(pairwise_distances(matrix, metric="cosine"), 0.0, None)
        np.fill_diagonal(dist, 0.0)

        def run(eps: float, mp: int) -> np.ndarray:
            return DBSCAN(eps=eps, min_samples=mp, metric="precomputed").fit_predict(dist)
    else:
        def run(eps: float, mp: int) -> np.ndarray:
            return DBSCAN(eps=eps, min_samples=mp, metric="cosine").fit_predict(matrix)

    def fill(mp: int, i: int) -> None:
        nonlocal done
        c, m = _counts(run(epsilons[i], mp))
        lines[mp]["clusters"][i], lines[mp]["would_mute"][i] = c, m
        done += 1
        if progress_cb:
            progress_cb(done, total)

    first = mps[0]
    for i in range(len(epsilons)):
        fill(first, i)
    found = window_of(lines[first]["clusters"], lines[first]["would_mute"])  # type: ignore[arg-type]
    window = None
    if found is not None:
        lo, hi = found
        window = {"from": epsilons[lo], "to": epsilons[hi]}
        total = len(epsilons) + (hi - lo + 1) * (len(mps) - 1)
        for mp in mps[1:]:
            for i in range(lo, hi + 1):
                fill(mp, i)
    return {"epsilons": epsilons, "min_points": mps, "lines": lines, "window": window, "peak": peak_of(lines, epsilons), "frames": n}


def sweep(
    camera: str, feature: str, *, method: str, epsilons: list[float], min_points: list[int],
    embedding_progress=None, progress_cb=None,
) -> dict:
    """:func:`sweep_matrix` over the feature's frame-set embeddings (the same ones :func:`cluster` uses)."""
    kept, matrix = fetch_embeddings(camera, feature, live_frames(camera, feature), method, embedding_progress)
    out = sweep_matrix(matrix, epsilons=epsilons, min_points=min_points, progress_cb=progress_cb)
    out["frames"] = len(kept)
    out["method"] = method
    return out


def cluster_matrix(
    kept: list[str], matrix: np.ndarray, *, epsilon: float, min_points: int, method: str,
) -> ClusterResult:
    """DBSCAN over an already-fetched ``matrix`` whose rows are the frames in ``kept``."""
    from sklearn.cluster import DBSCAN  # noqa: PLC0415  (optional dep, import lazily)

    if matrix.shape[0] == 0:
        return ClusterResult(
            method=method, epsilon=epsilon, min_points=min_points,
            labels_by_frame={}, clusters=[], representatives={}, frame_order=kept,
            embeddings=matrix,
        )

    db_ = DBSCAN(eps=epsilon, min_samples=min_points, metric="cosine")
    raw_labels = db_.fit_predict(matrix)

    labels_by_frame = {f: int(cid) for f, cid in zip(kept, raw_labels, strict=True)}

    real_ids = sorted({int(c) for c in raw_labels if c != NOISE})
    reps: dict[int, str] = {}
    for cid in real_ids:
        idx = np.where(raw_labels == cid)[0]
        centroid = matrix[idx].mean(axis=0)
        # closest-to-centroid by cosine distance (matrix rows are unit-norm)
        centroid /= np.linalg.norm(centroid) or 1.0
        sims = matrix[idx] @ centroid
        rep_local = int(idx[int(np.argmax(sims))])
        reps[cid] = kept[rep_local]

    # Order clusters by member count desc, then by id asc for stability.
    clusters = sorted(
        real_ids,
        key=lambda cid: (-int(np.sum(raw_labels == cid)), cid),
    )
    return ClusterResult(
        method=method, epsilon=epsilon, min_points=min_points,
        labels_by_frame=labels_by_frame, clusters=clusters,
        representatives=reps, frame_order=kept, embeddings=matrix,
    )


def recluster_without(result: ClusterResult, removed: set[str]) -> ClusterResult:
    """The same clustering settings over ``result``'s frames minus ``removed``.

    Used when frames are soft-deleted after a clustering: the stored vectors are
    reused, so nothing is re-embedded.
    """
    keep = [i for i, f in enumerate(result.frame_order) if f not in removed]
    if len(keep) == len(result.frame_order):
        return result
    kept = [result.frame_order[i] for i in keep]
    matrix = result.embeddings[keep] if result.embeddings.size else result.embeddings
    fresh = cluster_matrix(
        kept, matrix, epsilon=result.epsilon, min_points=result.min_points, method=result.method,
    )
    return _keep_cluster_ids(result, fresh)


def _keep_cluster_ids(old: ClusterResult, fresh: ClusterResult) -> ClusterResult:
    """Renumber ``fresh`` so each cluster keeps the id of the old cluster it overlaps most.

    DBSCAN numbers clusters by discovery order, so after a few frames disappear the ids could
    shift and the cluster the user is looking at would turn into another one.
    """
    overlap: list[tuple[int, int, int]] = []  # (shared frames, old id, new id)
    for new_id in fresh.clusters:
        members = set(fresh.members(new_id))
        for old_id in old.clusters:
            shared = len(members & set(old.members(old_id)))
            if shared:
                overlap.append((shared, old_id, new_id))
    mapping: dict[int, int] = {}
    used: set[int] = set()
    for _shared, old_id, new_id in sorted(overlap, key=lambda t: (-t[0], t[1], t[2])):
        if new_id not in mapping and old_id not in used:
            mapping[new_id] = old_id
            used.add(old_id)
    next_id = max([*old.clusters, *mapping.values(), -1]) + 1
    for new_id in fresh.clusters:
        if new_id not in mapping:
            mapping[new_id] = next_id
            next_id += 1
    rename = lambda cid: mapping.get(cid, cid)  # noqa: E731 - NOISE (-1) is not in the mapping
    return ClusterResult(
        method=fresh.method, epsilon=fresh.epsilon, min_points=fresh.min_points,
        labels_by_frame={f: rename(cid) for f, cid in fresh.labels_by_frame.items()},
        clusters=[rename(cid) for cid in fresh.clusters],
        representatives={rename(cid): f for cid, f in fresh.representatives.items()},
        frame_order=fresh.frame_order, embeddings=fresh.embeddings,
    )


# --- apply -------------------------------------------------------------------
@dataclass
class ApplyReport:
    muted: int
    unmuted: int
    skipped_labeled: int
    skipped_golden: int
    skipped_representative: int


def apply(
    camera: str,
    feature: str,
    result: ClusterResult,
    chosen_representatives: dict[int, str] | None = None,
) -> ApplyReport:
    """Reconcile the mute state to reflect the current clustering.

    - Every clustered non-representative frame gets muted (unless labeled or golden).
    - Every currently-muted frame that shouldn't be muted anymore under this
      clustering — because it's now noise, now the representative of its cluster,
      or now labeled/golden — gets unmuted.

    This makes ``apply`` idempotent with respect to the visible cluster shape:
    the frames the user sees in the Dedup UI as clustered non-reps become
    exactly the muted set, regardless of what past runs left behind.

    Golden frames are always kept visible, and so are labeled ones outside a Dedup box; this guards the domain
    invariant that a golden is a labeled frame the user trusts. A Dedup box behind a Classifier may mute labeled frames.
    """
    import dedup_box  # noqa: PLC0415

    # A Dedup box reads its Classifier's labels and goldens. Behind a Classifier every picture is labeled, so a box
    # may mute labeled pictures; a golden is never muted.
    marks_from = dedup_box.label_source(camera, feature)
    lab = {} if dedup_box.is_box(feature) else labels.current_labels(camera, marks_from)
    gold_map = labels.current_goldens(camera, marks_from)
    golden_frames = {f for frames in gold_map.values() for f in frames}

    hmap = labels.hash_map(camera)
    picks = {**result.representatives, **(chosen_representatives or {})}

    want_muted: set[str] = set()
    to_mute_records: list[tuple[str, str, int]] = []
    skipped_labeled = skipped_golden = skipped_rep = 0

    for cid in result.clusters:
        rep = picks.get(cid, result.representatives.get(cid))
        for f in result.members(cid):
            if f == rep:
                skipped_rep += 1
                continue
            if f in golden_frames:
                skipped_golden += 1
                continue
            if f in lab:
                skipped_labeled += 1
                continue
            want_muted.add(f)
            to_mute_records.append((f, hmap.get(f, ""), cid))

    currently_muted = db.muted_frames(camera, feature)
    # Delta forward: insert anything new. Delta backward: delete anything stale.
    # Only actual state changes need writes.
    to_mute_now = [rec for rec in to_mute_records if rec[0] not in currently_muted]
    to_unmute_now = sorted(currently_muted - want_muted)

    db.add_dedup_mutes(camera, feature, to_mute_now)
    db.add_dedup_unmutes(camera, feature, to_unmute_now)

    # Persist a per-frame snapshot so the Classify grid can annotate frames
    # with their cluster id. Overwrites any prior snapshot for this feature.
    _save_snapshot(camera, feature, result, picks)

    return ApplyReport(
        muted=len(to_mute_now),
        unmuted=len(to_unmute_now),
        skipped_labeled=skipped_labeled,
        skipped_golden=skipped_golden,
        skipped_representative=skipped_rep,
    )


def mute_frames(camera: str, feature: str, frames: list[str]) -> dict[str, int]:
    """Mute pictures picked by hand (a Scatter selection) in a Dedup box. A golden is never muted; pictures the box does
    not see are ignored. Muting again what is already muted changes nothing."""
    import dedup_box  # noqa: PLC0415

    marks_from = dedup_box.label_source(camera, feature)
    golden = {f for fs in labels.current_goldens(camera, marks_from).values() for f in fs}
    sees = set(live_frames(camera, feature))
    already = db.muted_frames(camera, feature)
    hmap = labels.hash_map(camera)
    wanted = list(dict.fromkeys(frames))
    skipped_golden = sum(1 for f in wanted if f in golden and f in sees)
    fresh = [f for f in wanted if f in sees and f not in golden and f not in already]
    db.add_dedup_mutes(camera, feature, [(f, hmap.get(f, ""), NOISE) for f in fresh], source="scatter")
    return {"muted": len(fresh), "skipped_golden": skipped_golden, "already": sum(1 for f in wanted if f in already)}


def _save_snapshot(camera, feature, result: ClusterResult, picks: dict[int, str]) -> None:
    """Write one row into cluster_snapshot with every frame's cluster id + rep flag."""
    rep_set = set(picks.values())
    frames: dict[str, list] = {}
    for f, cid in result.labels_by_frame.items():
        frames[f] = [int(cid), bool(f in rep_set)]
    payload = json.dumps({
        "frames": frames,
        "method": result.method,
        "epsilon": float(result.epsilon),
        "min_points": int(result.min_points),
        "clusters": [int(c) for c in result.clusters],
    }).encode("utf-8")
    db.save_cluster_snapshot(camera, feature, payload)


def load_snapshot(camera: str, feature: str) -> dict[str, tuple[int, bool]] | None:
    """Return {frame: (cluster_id, is_rep)} from the last-applied clustering, or None.

    NOISE (cluster_id == -1) frames appear too; a lookup miss means the frame
    wasn't part of that clustering (e.g. ingested since apply).
    """
    raw = db.load_cluster_snapshot(camera, feature)
    for box in db.feeding_boxes(camera, feature):  # a Classifier fed by a Dedup box shows that box's clusters
        if raw is None:
            raw = db.load_cluster_snapshot(camera, box)
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001 — malformed snapshot shouldn't wedge callers
        applog.warn_once(_log, "cluster-snapshot", "unreadable cluster snapshot, ignored")
        return None
    frames = data.get("frames") or {}
    return {f: (int(cid), bool(is_rep)) for f, (cid, is_rep) in frames.items()}


def summary(result: ClusterResult) -> dict[str, int]:
    """Human-friendly readout: cluster count, covered frames, noise (unique) frames."""
    covered = sum(1 for cid in result.labels_by_frame.values() if cid != NOISE)
    return {
        "clusters": len(result.clusters),
        "covered": covered,
        "unique": len(result.noise_frames),
        "total": len(result.labels_by_frame),
    }
