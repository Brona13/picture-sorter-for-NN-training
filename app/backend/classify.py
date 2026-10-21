"""Multi-class classification scoring: distance to each class's goldens.

For every frame in a feature's frame set, and for every scoring method (cpu
classical, plus each available ResNet backbone), compute:

  * ``dists``   — {class: distance to the *nearest* golden of that class} (a
                  value is None for a class with no goldens yet)
  * ``leaning`` — the nearest class, when at least two classes have goldens
  * ``margin``  — (2nd-smallest distance − smallest); small = uncertain, review first
  * ``novelty`` — min distance over all classes (far from ALL goldens = unusual)

The class vocabulary is per-feature (``datamodel.classes_for``): OK/NG for a
quality ROI, the product names for a ``classify`` ROI. Two classes generalise the
old OK-vs-NG behaviour exactly (leaning = the closer, margin = |d0 − d1|).

Cold start is graceful: with fewer than two classes carrying goldens, leaning and
margin are None and novelty falls back to the nearest available distance.

**Goldens are references, not candidates** — a frame marked golden is never scored.
You chose it because you are certain of it, so comparing it against other references
only invites a meaningless verdict ("this 2x4 reference leans 4x4RS"). Its
``FrameScore`` carries the golden class and an empty ``per_method``.

The expensive per-frame work (histogram, standardized gray, ResNet embeddings) is
cached in SQLite keyed by (content-hash, feature, ROI box, kind) — so the first
refresh of a new batch pays the model cost once, and every refresh after a golden
change only recomputes distances.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import cv2
import numpy as np

import anchor
import roi_input
import config
import curation
import datamodel
import db
import detections
import embedding
import engine
import labels
import methods_config
import perf
import vision_settings


# --- results -----------------------------------------------------------------
@dataclass
class MethodScore:
    dists: dict[str, float | None]      # class -> distance to its nearest golden
    leaning: str | None
    margin: float | None
    novelty: float


@dataclass
class FrameScore:
    frame: str                                  # filename in unsorted/
    golden: str | None                          # class this frame is golden FOR, or None
    per_method: dict[str, MethodScore] = field(default_factory=dict)


@dataclass(frozen=True)
class ProgressUpdate:
    """One phase-aware scoring progress event for presentation-layer callers."""
    phase: str
    done: int = 0
    total: int = 0
    detail: str | None = None


@dataclass
class _PreparedVectorCache:
    """Compact cached blobs ready for bounded decoding and comparison."""
    frame_hashes: dict[str, str]
    blobs_by_hash: dict[str, dict[str, bytes]]
    kept: list[str]
    kinds: list[str]
    kept_set: set[str] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.kept_set = set(self.kept)


def _emit_progress(callback, phase: str, done=0, total=0, detail=None) -> None:
    if callback is not None:
        callback(ProgressUpdate(phase=phase, done=done, total=total, detail=detail))


def methods_available() -> list[str]:
    """The scoring methods in use: the installed ones that are switched on (Configuration page)."""
    return methods_config.active()


def active_backbones() -> list[str]:
    """The neural methods in use."""
    return methods_config.active_backbones()


# --- cached per-frame vectors ------------------------------------------------
def _roi_cache_key(roi, camera: str | None = None, feature: str | None = None, con=None) -> str:
    """Cache key for a ROI; carries the feature's vision-settings signature if any."""
    key = f"{roi.x:.4f},{roi.y:.4f},{roi.w:.4f},{roi.h:.4f}"
    sig = vision_settings.signature(camera, feature, con) if camera and feature else ""
    key = f"{key}|{sig}" if sig else key
    spec = anchor.get_anchor(camera, feature, con) if camera and feature else None
    if camera and feature:
        edits = roi_input.rule_key(camera, feature, con)
        key = f"{key}|{edits}" if edits else key
    return f"{key}|{anchor.rule_key(spec, camera)}" if spec else key


def _chunks(items: list, size: int):
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _load_cached_blobs(
    con, feature: str, roi_key: str, hashes: list[str], kinds: list[str]
) -> dict:
    """Bulk-load only the requested cached kinds for the supplied hashes."""
    out: dict[str, dict[str, bytes]] = {}
    if not hashes or not kinds:
        return out
    query_size = max(1, int(getattr(config, "FEATURE_CACHE_QUERY_BATCH_SIZE", 400)))
    for hash_batch in _chunks(list(dict.fromkeys(hashes)), query_size):
        hash_placeholders = ",".join("?" for _ in hash_batch)
        kind_placeholders = ",".join("?" for _ in kinds)
        perf.count("score_cache.bulk_queries")
        with perf.span("score_cache.lookup"):
            rows = con.execute(
                f"SELECT hash, kind, vec FROM score_cache "
                f"WHERE feature=? AND roi_key=? "
                f"AND hash IN ({hash_placeholders}) "
                f"AND kind IN ({kind_placeholders})",
                (feature, roi_key, *hash_batch, *kinds),
            ).fetchall()
        perf.count("score_cache.rows_read", len(rows))
        for row in rows:
            out.setdefault(row["hash"], {})[row["kind"]] = row["vec"]
    return out


def _write_cache_rows(con, rows: list[tuple]) -> None:
    """Persist derived vectors in bounded transactions."""
    if not rows:
        return
    write_size = max(1, int(getattr(config, "FEATURE_CACHE_WRITE_BATCH_SIZE", 128)))
    sql = (
        "INSERT OR REPLACE INTO score_cache(hash, feature, roi_key, kind, vec, ts) "
        "VALUES (?,?,?,?,?,?)"
    )
    for batch in _chunks(rows, write_size):
        with perf.span("score_cache.write_batch"):
            con.executemany(sql, batch)
            con.commit()
        perf.count("score_cache.write_batches")
        perf.count("score_cache.rows_written", len(batch))


def _prepare_vector_cache(
    con,
    camera: str,
    feature: str,
    roi_key: str,
    roi,
    frames: list[str],
    hmap: dict[str, str],
    backbones: list[str],
    *,
    include_classical: bool = True,
    progress_cb=None,
) -> _PreparedVectorCache:
    """Bulk load or derive compact blobs without retaining decoded gray arrays."""
    kinds = (["hist", "gray"] if include_classical else []) + list(backbones)
    vision = vision_settings.get(camera, feature, con)
    offsets = detections.offsets(camera, feature, vision, con)
    frame_hashes: dict[str, str] = {}
    frame_offsets: dict[str, tuple[float, float]] = {}
    spec = anchor.get_anchor(camera, feature, con)  # a detector-anchored ROI: its rectangle differs per picture
    source = anchor.Source(camera, spec) if spec else None
    if spec:
        spec = anchor.effective(camera, feature, spec, source)
    frame_entries: dict[str, dict] = {}
    unavailable: set[str] = set()
    for f in frames:
        h = labels.frame_hash(camera, f, hmap)
        if spec:
            entry = source.entry(h)
            if entry is None:  # the detector found nothing here: no rectangle, no vectors
                unavailable.add(f)
            else:
                frame_entries[f] = entry
                h = f"{h}@{anchor.frame_key(spec, entry)}"
        if h in offsets:  # the mask follows this frame's detection: its vectors are specific to it
            frame_offsets[f] = offsets[h]
            h = f"{h}@{offsets[h][0]:+.4f},{offsets[h][1]:+.4f}"
        frame_hashes[f] = h
    blobs_by_hash = _load_cached_blobs(
        con, feature, roi_key, list(frame_hashes.values()), kinds
    )
    missing_by_frame = {
        frame: [kind for kind in kinds if kind not in blobs_by_hash.get(h, {})]
        for frame, h in frame_hashes.items()
    }
    perf.count(
        "score_cache.kind_hits",
        sum(len(kinds) - len(missing) for missing in missing_by_frame.values()),
    )
    perf.count(
        "score_cache.kind_misses",
        sum(len(missing) for missing in missing_by_frame.values()),
    )

    reported: set[str] = set()
    completed = 0

    def report_ready(frame: str) -> None:
        nonlocal completed
        if frame in reported:
            return
        h = frame_hashes[frame]
        if frame in unavailable or all(
            kind in blobs_by_hash.get(h, {}) for kind in kinds
        ):
            reported.add(frame)
            completed += 1
            if progress_cb:
                progress_cb(completed, len(frames))

    for frame in frames:
        if not missing_by_frame[frame] or frame in unavailable:
            report_ready(frame)

    prep_size = max(1, int(getattr(config, "SCORING_VECTOR_BATCH_SIZE", 32)))
    frames_missing_any = [frame for frame in frames if missing_by_frame[frame] and frame not in unavailable]
    for frame_batch in _chunks(frames_missing_any, prep_size):
        cutouts: dict[str, np.ndarray] = {}
        for frame in frame_batch:
            try:
                with perf.span("features.image_load_and_crop"):
                    img = roi_input.apply(camera, feature, curation.load_image(datamodel.unsorted_dir(camera) / frame))
                    frame_roi = roi
                    if frame in frame_entries:
                        frame_roi = anchor.rect_for(spec, frame_entries[frame], roi.name, img.shape[1], img.shape[0])
                        if frame_roi is None:  # the rectangle lies outside this picture
                            raise FileNotFoundError(frame)
                    cutouts[frame] = frame_roi.crop(img)
                    cutouts[frame] = vision_settings.apply_settings(
                        vision, cutouts[frame], frame_offsets.get(frame)
                    )
            except FileNotFoundError:
                unavailable.add(frame)
                report_ready(frame)

        available_batch = [frame for frame in frame_batch if frame in cutouts]
        classical_rows: list[tuple] = []
        ts = time.time()
        for frame in available_batch:
            h = frame_hashes[frame]
            blobs = blobs_by_hash.setdefault(h, {})
            missing = missing_by_frame[frame]
            if "hist" in missing:
                with perf.span("features.histogram"):
                    blob = (
                        curation._hsv_histogram(cutouts[frame])
                        .astype(np.float32)
                        .tobytes()
                    )
                blobs["hist"] = blob
                classical_rows.append((h, feature, roi_key, "hist", blob, ts))
            if "gray" in missing:
                with perf.span("features.gray"):
                    gray01 = curation._gray_standard(cutouts[frame])
                    ok, buf = cv2.imencode(
                        ".png", (gray01 * 255).astype(np.uint8)
                    )
                    if not ok:
                        raise RuntimeError("could not encode cached grayscale feature")
                    blob = buf.tobytes()
                blobs["gray"] = blob
                classical_rows.append((h, feature, roi_key, "gray", blob, ts))
        _write_cache_rows(con, classical_rows)
        for frame in available_batch:
            report_ready(frame)

        for backbone in backbones:
            missing_frames = [
                frame for frame in available_batch
                if backbone in missing_by_frame[frame]
            ]
            missing_cutouts = [cutouts[frame] for frame in missing_frames]
            for start, matrix in embedding.iter_embed_batches(
                missing_cutouts, backbone
            ):
                batch_frames = missing_frames[start : start + len(matrix)]
                rows: list[tuple] = []
                for frame, vec in zip(batch_frames, matrix, strict=True):
                    h = frame_hashes[frame]
                    blob = vec.astype(np.float32).tobytes()
                    blobs_by_hash.setdefault(h, {})[backbone] = blob
                    rows.append(
                        (h, feature, roi_key, backbone, blob, time.time())
                    )
                _write_cache_rows(con, rows)
                for frame in batch_frames:
                    report_ready(frame)

    kept = [frame for frame in frames if frame not in unavailable]
    return _PreparedVectorCache(frame_hashes, blobs_by_hash, kept, kinds)


def _decode_vectors(
    prepared: _PreparedVectorCache, frames: list[str]
) -> dict[str, dict[str, np.ndarray]]:
    """Decode one bounded frame group from compact cache blobs."""
    out: dict[str, dict[str, np.ndarray]] = {}
    for frame in frames:
        if frame not in prepared.kept_set:
            continue
        blobs = prepared.blobs_by_hash[prepared.frame_hashes[frame]]
        vectors: dict[str, np.ndarray] = {}
        for kind in prepared.kinds:
            raw = blobs[kind]
            if kind == "gray":
                with perf.span("features.gray_decode"):
                    arr = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
                    vectors[kind] = arr.astype(np.float32) / 255.0
            else:
                vectors[kind] = np.frombuffer(raw, dtype=np.float32)
        out[frame] = vectors
    return out


def fetch_vectors(
    con,
    camera: str,
    feature: str,
    roi_key: str,
    roi,
    frames: list[str],
    hmap: dict[str, str],
    backbones: list[str],
    *,
    include_classical: bool = True,
    progress_cb=None,
) -> dict[str, dict[str, np.ndarray]]:
    """Compatibility wrapper returning all requested decoded vectors."""
    prepared = _prepare_vector_cache(
        con,
        camera,
        feature,
        roi_key,
        roi,
        frames,
        hmap,
        backbones,
        include_classical=include_classical,
        progress_cb=progress_cb,
    )
    return _decode_vectors(prepared, prepared.kept)


# --- distances ---------------------------------------------------------------
def _method_distance(method: str, a: dict, b: dict) -> float:
    """Distance between two frames' vector dicts under one method."""
    if method == "cpu":
        with perf.span("scoring.comparison.cpu.histogram"):
            histogram = curation._hist_distance(a["hist"], b["hist"])
        with perf.span("scoring.comparison.cpu.mse"):
            mse = curation._mse_distance(a["gray"], b["gray"])
        with perf.span("scoring.comparison.cpu.ssim"):
            ssim = curation._ssim_distance(a["gray"], b["gray"])
        d = {"histogram": histogram, "mse": mse, "ssim": ssim}
        return curation.combine(d, keys=config.METRIC_FAMILIES["cpu"])
    return embedding.cosine_distance(a[method], b[method])


def _score_method(method, vecs, golden_vecs, classes):
    """MethodScore for one candidate frame against every class's golden set."""
    dists: dict[str, float | None] = {}
    for cls in classes:
        refs = golden_vecs.get(cls, [])
        dists[cls] = (
            min(_method_distance(method, vecs, v) for _, v in refs) if refs else None
        )
    return _method_score_from_dists(dists)


def _method_score_from_dists(dists: dict[str, float | None]) -> MethodScore:
    """Build a score from per-class nearest distances."""
    # Rank the classes that actually have references, nearest first.
    ranked = sorted(((d, c) for c, d in dists.items() if d is not None))
    if len(ranked) >= 2:
        novelty = ranked[0][0]
        leaning = ranked[0][1]
        margin = ranked[1][0] - ranked[0][0]
    elif len(ranked) == 1:
        novelty, leaning, margin = ranked[0][0], None, None
    else:
        novelty, leaning, margin = 0.0, None, None
    return MethodScore(dists=dists, leaning=leaning, margin=margin, novelty=novelty)


def _distance_job(job) -> float:
    method, candidate, golden = job
    return _method_distance(method, candidate, golden)


def _score_cpu_batch(
    candidate_items: list[tuple[str, dict]],
    golden_vecs: dict[str, list],
    classes: list[str],
    executor: ThreadPoolExecutor,
) -> dict[str, MethodScore]:
    """Evaluate exact classical distances concurrently across independent pairs."""
    nearest = {
        frame: {cls: None for cls in classes} for frame, _vecs in candidate_items
    }
    jobs = []
    destinations: list[tuple[str, str]] = []
    for frame, vecs in candidate_items:
        for cls in classes:
            for _golden_frame, golden in golden_vecs.get(cls, []):
                jobs.append(("cpu", vecs, golden))
                destinations.append((frame, cls))

    for (frame, cls), distance in zip(
        destinations, executor.map(_distance_job, jobs), strict=True
    ):
        current = nearest[frame][cls]
        if current is None or distance < current:
            nearest[frame][cls] = distance
    return {
        frame: _method_score_from_dists(nearest[frame])
        for frame, _vecs in candidate_items
    }


def _score_neural_batch(
    method: str,
    candidate_items: list[tuple[str, dict]],
    golden_vecs: dict[str, list],
    classes: list[str],
) -> dict[str, MethodScore]:
    """Vectorize cosine distances for one embedding backbone."""
    if not candidate_items:
        return {}
    candidate_matrix = np.stack([vecs[method] for _frame, vecs in candidate_items])
    per_frame = {
        frame: {cls: None for cls in classes} for frame, _vecs in candidate_items
    }
    for cls in classes:
        refs = golden_vecs.get(cls, [])
        if not refs:
            continue
        golden_matrix = np.stack([vecs[method] for _frame, vecs in refs])
        similarities = candidate_matrix @ golden_matrix.T
        distances = np.clip((1.0 - similarities.astype(np.float64)) / 2.0, 0.0, 1.0)
        nearest = distances.min(axis=1)
        for (frame, _vecs), distance in zip(candidate_items, nearest, strict=True):
            per_frame[frame][cls] = float(distance)
    return {
        frame: _method_score_from_dists(per_frame[frame])
        for frame, _vecs in candidate_items
    }


def _score_candidate_batch(
    candidate_vecs: dict[str, dict],
    golden_vecs: dict[str, list],
    classes: list[str],
    methods: list[str],
    executor: ThreadPoolExecutor,
) -> dict[str, dict[str, MethodScore]]:
    """Score one bounded candidate group, preserving its input order."""
    items = list(candidate_vecs.items())
    out = {frame: {} for frame, _vecs in items}
    for method in methods:
        with perf.span(f"scoring.comparison.{method}"):
            if method == "cpu":
                scores = _score_cpu_batch(items, golden_vecs, classes, executor)
            else:
                scores = _score_neural_batch(
                    method, items, golden_vecs, classes
                )
        for frame, score in scores.items():
            out[frame][method] = score
    return out


# --- the refresh -------------------------------------------------------------
def refresh(
    camera: str,
    feature: str,
    phase_progress_cb=None,
) -> list[FrameScore]:
    """Score every candidate frame against the current golden sets, all methods.

    Frames marked golden are returned unscored (they are the references). With zero
    goldens marked, everything comes back unscored so the UI can still browse frames
    to mark the first ones.
    """
    _emit_progress(phase_progress_cb, "discovery", 0, 1)
    with perf.span("scoring.discovery"):
        roi = engine.resolve_roi(camera, feature)
        roi_key = _roi_cache_key(roi)
        classes = datamodel.classes_for(camera, feature)
        goldens = labels.current_goldens(camera, feature)
        frames = datamodel.frames_for_feature(camera, feature)
        hmap = labels.hash_map(camera)
        methods = methods_available()
        backbones = [m for m in methods if m != "cpu"]  # a method that is switched off is not computed
        any_golden = any(goldens.get(c) for c in classes)
    _emit_progress(
        phase_progress_cb, "discovery", 1, 1, detail=f"{len(frames)} frames"
    )
    perf.count("scoring.frames", len(frames))
    perf.count("scoring.goldens", sum(len(v) for v in goldens.values()))
    perf.count("scoring.methods", len(methods))

    results: list[FrameScore] = []
    con = db.connect()
    try:
        roi_key = _roi_cache_key(roi, camera, feature, con)
        if not any_golden:
            return [
                FrameScore(frame=f, golden=labels.golden_class_of(goldens, f))
                for f in frames
            ]

        # Prepare compact cache blobs first; decoded candidate arrays are held
        # only for one bounded comparison batch at a time.
        total = len(frames)
        feature_detail = ", ".join(methods)
        _emit_progress(
            phase_progress_cb, "features", 0, total, detail=feature_detail
        )

        def vector_progress(done, count):
            _emit_progress(
                phase_progress_cb, "features", done, count, detail=feature_detail
            )

        with perf.span("scoring.features"):
            prepared = _prepare_vector_cache(
                con,
                camera,
                feature,
                roi_key,
                roi,
                frames,
                hmap,
                backbones,
                include_classical="cpu" in methods,
                progress_cb=vector_progress,
            )

        golden_classes_by_frame = {
            frame: cls
            for frame in prepared.kept
            if (cls := labels.golden_class_of(goldens, frame)) is not None
        }
        golden_frames = [
            frame for frame in prepared.kept if frame in golden_classes_by_frame
        ]
        golden_vectors = _decode_vectors(prepared, golden_frames)
        golden_vecs: dict[str, list] = {
            cls: [(f, golden_vectors[f]) for f in gframes if f in golden_vectors]
            for cls, gframes in goldens.items()
        }

        candidate_frames = [
            frame for frame in prepared.kept
            if frame not in golden_classes_by_frame
        ]
        comparison_total = len(candidate_frames)
        comparison_done = 0
        comparison_detail = ", ".join(methods)
        _emit_progress(
            phase_progress_cb,
            "comparison",
            0,
            comparison_total,
            detail=comparison_detail,
        )
        results_by_frame = {
            frame: FrameScore(frame=frame, golden=golden_classes_by_frame[frame])
            for frame in golden_frames
        }
        vector_batch_size = max(
            1, int(getattr(config, "SCORING_VECTOR_BATCH_SIZE", 32))
        )
        worker_count = max(
            1, int(getattr(config, "CLASSICAL_COMPARISON_WORKERS", 4))
        )
        perf.count("scoring.vector_batch_limit", vector_batch_size)
        perf.count(
            "scoring.decoded_frame_limit", vector_batch_size + len(golden_frames)
        )
        perf.count("scoring.classical_workers", worker_count)
        with perf.span("scoring.comparison"):
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                for frame_batch in _chunks(candidate_frames, vector_batch_size):
                    perf.count("scoring.candidate_batches")
                    candidate_vecs = _decode_vectors(prepared, frame_batch)
                    batch_scores = _score_candidate_batch(
                        candidate_vecs,
                        golden_vecs,
                        classes,
                        methods,
                        executor,
                    )
                    for frame in frame_batch:
                        if frame not in candidate_vecs:
                            continue
                        fs = FrameScore(frame=frame, golden=None)
                        fs.per_method = batch_scores[frame]
                        results_by_frame[frame] = fs
                        comparison_done += 1
                        _emit_progress(
                            phase_progress_cb,
                            "comparison",
                            comparison_done,
                            comparison_total,
                            detail=comparison_detail,
                        )
                    # Release decoded float arrays before the next batch is built.
                    del candidate_vecs, batch_scores
        results = [
            results_by_frame[frame]
            for frame in frames
            if frame in results_by_frame
        ]
    finally:
        con.close()
    return results


def serialise_results(results: list[FrameScore]) -> bytes:
    """JSON-encode a scored list for the persistent results cache."""
    with perf.span("results.serialize"):
        payload = [
            {
                "frame": r.frame,
                "golden": r.golden,
                "per_method": {
                    m: {
                        "dists": ms.dists,
                        "leaning": ms.leaning,
                        "margin": ms.margin,
                        "novelty": ms.novelty,
                    }
                    for m, ms in r.per_method.items()
                },
            }
            for r in results
        ]
        blob = json.dumps(payload).encode("utf-8")
    perf.count("results.payload_bytes", len(blob))
    return blob


def deserialise_results(blob: bytes, methods: list[str] | None = None) -> list[FrameScore]:
    """Inverse of ``serialise_results`` for the current cache format.

    ``methods`` limits the result to those methods (the ones switched on); without it every stored method
    is returned.
    """
    with perf.span("results.deserialize"):
        data = json.loads(blob.decode("utf-8"))
        out: list[FrameScore] = []
        for r in data:
            fs = FrameScore(frame=r["frame"], golden=r["golden"])
            for m, ms in r["per_method"].items():
                if methods is not None and m not in methods:
                    continue
                fs.per_method[m] = MethodScore(
                    dists=ms["dists"],
                    leaning=ms["leaning"],
                    margin=ms["margin"],
                    novelty=ms["novelty"],
                )
            out.append(fs)
    perf.count("results.payload_bytes_read", len(blob))
    return out


def missing_methods(results: list[FrameScore], methods: list[str]) -> list[str]:
    """Methods that are switched on but have no scores in these cached results (they need a refresh)."""
    scored = next((r for r in results if r.per_method), None)
    if scored is None:
        return []
    return [m for m in methods if m not in scored.per_method]


def stats_for(results: list[FrameScore]) -> dict:
    """Per-method novelty statistics (mean/median/min/max) for version snapshots."""
    out: dict[str, dict] = {}
    for m in methods_available():
        vals = [r.per_method[m].novelty for r in results if m in r.per_method]
        if vals:
            arr = np.array(vals)
            out[m] = {
                "mean": round(float(arr.mean()), 5),
                "median": round(float(np.median(arr)), 5),
                "min": round(float(arr.min()), 5),
                "max": round(float(arr.max()), 5),
            }
    return out
