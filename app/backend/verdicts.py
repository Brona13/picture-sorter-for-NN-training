"""Project verdicts: one OK / NG decision per picture, combined from every quality ROI's label.

Rules (see plans/project-verdict-plan.md):

* The inputs of a picture are the current ``OK`` / ``NG`` labels of its quality ROIs (classify-role ROIs and
  other classes are ignored). Manual, bulk and auto labels weigh the same; the label also records the page it
  was set on (``labels.via``).
* No input = ``open``. All inputs the same class = that verdict (``auto``, final). Any other mix = ``contradiction``.
* The user can decide a picture (``verdict_decisions``). The decision stores a signature of the inputs at that
  moment; when an input changes afterwards the picture is ``stale`` until the user confirms or changes it.
* Deleted pictures are left out. Pictures muted by Dedup that have no verdict are counted as ``duplicates``
  instead of ``open``; their verdict, when they have one, is untouched.

Everything except the decisions is derived on read, so there is nothing to keep in sync.
"""
from __future__ import annotations

import json
import time

import datamodel
import db
import labels

CLASSES = ("OK", "NG")
STATUSES = ("ok", "ng", "open", "contradiction", "stale", "duplicates")


class VerdictError(ValueError):
    """A verdict request that cannot be honoured."""


def quality_features(camera: str) -> set[str]:
    """Every label feature of a quality ROI (``roi`` or ``product::roi``); the classify-role ROI is excluded."""
    classify = datamodel.classify_feature(camera)
    out: set[str] = set()
    con = db.connect()
    try:
        rows = con.execute("SELECT DISTINCT feature FROM labels WHERE camera=?", (camera,)).fetchall()
    finally:
        con.close()
    for r in rows:
        feat = r["feature"]
        if classify is not None and feat.split(datamodel.FEATURE_SEP)[-1] == classify:
            continue
        out.add(feat)
    return out


def _inputs(camera: str) -> dict[str, list[dict]]:
    """Per frame: the OK / NG labels of the quality ROIs with their origin, ordered by ROI name."""
    features = quality_features(camera)
    out: dict[str, list[dict]] = {}
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT feature, frame, class, source, via, updated FROM labels "
            "WHERE camera=? AND class IN ('OK','NG') ORDER BY feature, frame",
            (camera,),
        ).fetchall()
    finally:
        con.close()
    for r in rows:
        if r["feature"] not in features:
            continue
        out.setdefault(r["frame"], []).append(
            {
                "feature": r["feature"],
                "short_name": r["feature"].split(datamodel.FEATURE_SEP)[-1],
                "cls": r["class"],
                "source": r["source"],
                "via": r["via"],
                "updated": r["updated"],
            }
        )
    return out


def signature(inputs: list[dict]) -> str:
    """What a decision is based on: which ROI said which class (origin and time do not matter)."""
    return json.dumps(sorted([i["feature"], i["cls"]] for i in inputs), separators=(",", ":"))


def _decisions(camera: str) -> dict[str, dict]:
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT frame, class, inputs_sig, updated FROM verdict_decisions WHERE camera=?", (camera,)
        ).fetchall()
    finally:
        con.close()
    return {r["frame"]: {"cls": r["class"], "sig": r["inputs_sig"], "updated": r["updated"]} for r in rows}


def _muted(camera: str) -> dict[str, list[str]]:
    con = db.connect()
    try:
        rows = con.execute("SELECT frame, feature FROM dedup_mute WHERE camera=? ORDER BY frame", (camera,)).fetchall()
    finally:
        con.close()
    out: dict[str, list[str]] = {}
    for r in rows:
        out.setdefault(r["frame"], []).append(r["feature"])
    return out


def _classify(inputs: list[dict], decision: dict | None) -> tuple[str, str | None, str | None]:
    """(status, verdict class, kind) of one picture; status is one of ok/ng/open/contradiction/stale."""
    if decision is not None:
        if decision["sig"] == signature(inputs):
            return decision["cls"].lower(), decision["cls"], "manual"
        return "stale", None, None
    classes = {i["cls"] for i in inputs}
    if not classes:
        return "open", None, None
    if len(classes) == 1:
        cls = next(iter(classes))
        return cls.lower(), cls, "auto"
    return "contradiction", None, None


def evaluate(camera: str) -> list[dict]:
    """One record per non-deleted picture, in file-name order."""
    frames = [p.name for p in datamodel.list_unsorted(camera)]
    deleted = db.deleted_frames_of(camera)
    inputs = _inputs(camera)
    decisions = _decisions(camera)
    muted = _muted(camera)
    out = []
    for frame in frames:
        if frame in deleted:
            continue
        ins = inputs.get(frame, [])
        dec = decisions.get(frame)
        status, verdict, kind = _classify(ins, dec)
        listed = status
        if status == "open" and frame in muted:
            listed = "duplicates"
        out.append(
            {
                "frame": frame,
                "status": status,
                "bucket": listed,
                "verdict": verdict,
                "kind": kind,
                "decision": dec["cls"] if dec else None,
                "inputs": ins,
                "muted_in": muted.get(frame, []),
            }
        )
    return out


def summary(camera: str) -> dict:
    records = evaluate(camera)
    counts = {s: 0 for s in STATUSES}
    for r in records:
        counts[r["bucket"]] += 1
    frames = len(datamodel.list_unsorted(camera))
    deleted = len(db.deleted_frames_of(camera) & {p.name for p in datamodel.list_unsorted(camera)})
    return {"frames": frames, "total": len(records), "deleted": deleted, **counts}


def listing(camera: str, status: str = "all", page: int = 1, per_page: int = 24) -> dict:
    if status != "all" and status not in STATUSES:
        raise VerdictError(f"Unknown status: {status}")
    records = [r for r in evaluate(camera) if status == "all" or r["bucket"] == status]
    per_page = max(1, min(per_page, 200))
    n_pages = max(1, -(-len(records) // per_page))
    page = max(1, min(page, n_pages))
    start = (page - 1) * per_page
    return {
        "status": status,
        "page": page,
        "per_page": per_page,
        "n_pages": n_pages,
        "total": len(records),
        "items": records[start : start + per_page],
    }


def record_for(camera: str, frame: str) -> dict | None:
    for r in evaluate(camera):
        if r["frame"] == frame:
            return r
    return None


def decide(camera: str, frame: str, cls: str | None) -> None:
    """Set the user's verdict for a picture (with a snapshot of its inputs), or clear it with ``None``."""
    if cls is not None and cls not in CLASSES:
        raise VerdictError(f"A verdict is OK or NG, not {cls!r}.")
    con = db.connect()
    try:
        if cls is None:
            con.execute("DELETE FROM verdict_decisions WHERE camera=? AND frame=?", (camera, frame))
        else:
            sig = signature(_inputs(camera).get(frame, []))
            con.execute(
                "INSERT INTO verdict_decisions(camera,frame,hash,class,inputs_sig,updated) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(camera,frame) DO UPDATE SET hash=excluded.hash,class=excluded.class,"
                "inputs_sig=excluded.inputs_sig,updated=excluded.updated",
                (camera, frame, labels.frame_hash(camera, frame), cls, sig, time.time()),
            )
        con.commit()
    finally:
        con.close()
