"""Lines into a Classifier's class dots (OK, NG, the product names).

A Classifier has one input dot per class. A line into the dot of a class says: these pictures are in this Classifier and
they belong to that class. The class comes from where the pictures come from, never from the box that passes them on:

* an Evaluation's ``pass`` dot is OK and its ``fail`` dot is NG (``flow.VERDICT_CLASS``);
* a Dedup box carries the class of what it reads (an Evaluation's pass or fail dot, or one class dot of a Classifier).
  Dedup only filters: it adds no label and changes none.

A Classifier sees the union of what its class dots receive (several lines into one dot must all pass a picture), and
those pictures are labelled with the dot's class, as the verdict labels of an Evaluation are (final; only goldens are
chosen). A picture that reaches two class dots with different meanings is left out and counted as a conflict.
* Ingest OK / Ingest NG (step 2, ``piles.py``) carry OK / NG and feed only a **step-2 Classifier**, whose labels then come
  from the last freeze of step 1 and are final; a step-2 Classifier takes no other line into its class dots.
  A step-2 Classifier anchored to a **Box** needs no line into its class dots (v1.149.0): the Ingest OK / NG boxes drawn into
  the Box say the class (``implied``), so the labels reach it through the Box.
Stored as the setting ``class.lines.<feature>``: a list of ``{"class", "box", "dot"?}``.
"""
from __future__ import annotations

import json

import applog
import datamodel
import db
import flow

KEY = db.CLASS_LINES_KEY


class ClassLineError(ValueError):
    """A line that cannot go into a class dot, with the reason."""


def get(camera: str, feature: str) -> list[dict]:
    """The stored lines of a Classifier, without those whose box is gone."""
    raw = db.get_setting(camera, f"{KEY}{feature}")
    if not raw:
        return []
    try:
        stored = json.loads(raw)
    except ValueError:
        return []
    graph = flow.load_graph(camera)
    return [ln for ln in stored if isinstance(ln, dict) and ln.get("box") in graph["nodes"] and ln.get("class")]


def implied(camera: str, feature: str) -> list[dict]:
    """The lines a step-2 Classifier anchored to a Box has without drawing them: one per Ingest OK / NG box drawn into the
    Box, into the dot of its class (``[{"class", "box"}]``). Nothing for any other Classifier. Never stored, never drawn."""
    if flow.roi_step(camera, feature) != 2:
        return []
    import box_module  # noqa: PLC0415
    import export_box  # noqa: PLC0415

    box = export_box.anchored_box(camera, feature)
    if not box:
        return []
    classes = datamodel.classes_for(camera, feature)
    graph = flow.load_graph(camera)
    return [{"class": flow.PILE_CLASS[flow.kind_of(pile)], "box": pile} for pile in box_module.piles_of(graph, box) if flow.PILE_CLASS[flow.kind_of(pile)] in classes]


def effective(camera: str, feature: str) -> list[dict]:
    """The lines that decide the Classifier's pictures and labels: the stored ones, else the ones its Box implies."""
    return get(camera, feature) or implied(camera, feature)


def _save(camera: str, feature: str, rows: list[dict]) -> None:
    if rows:
        db.set_setting(camera, f"{KEY}{feature}", json.dumps(rows, sort_keys=True))
    else:
        db.delete_setting(camera, f"{KEY}{feature}")


def meaning(camera: str, box: str, graph: dict | None = None, _seen: frozenset = frozenset()) -> str | None:
    """The class of the pictures a box passes on, or ``None`` when they have no single class.

    An Evaluation has no meaning of its own (its dot decides). A box that reads an Evaluation's pass / fail dot or a
    Classifier's class dot carries that class; a box that reads another box carries what that one carries; Ingest and
    the all dots carry none."""
    graph = graph or flow.load_graph(camera)
    kind = flow.kind_of(box)
    if box in _seen or box not in graph["nodes"] or kind in ("evaluation", "ingest"):
        return None
    if kind in flow.PILES:
        return flow.PILE_CLASS[kind]
    judged = flow.node_eval_source(graph, box)
    if judged:
        return flow.VERDICT_CLASS.get(judged["dot"])
    src = flow.node_source(graph, box)
    if src:
        return None if src["dot"] == flow.lines.ALL_DOT else src["dot"]
    if kind == "merge":
        return flow.merge_meaning(graph, box)
    line = next((e for e in graph["edges"] if e["target"] == box and flow.kind_of(e["source"]) in ("crop", "detector", "dedup", "merge")), None)
    if line is None:
        return None
    return meaning(camera, line["source"], graph, _seen | {box})


def check(camera: str, feature: str, cls: str, box: str, dot: str | None) -> str | None:
    """``None`` when ``box`` (and ``dot``) may feed the ``cls`` dot of ``feature``, else why not."""
    if datamodel.get_roi(camera, feature) is None:
        return f"Unknown ROI: {feature}"
    classes = datamodel.classes_for(camera, feature)
    if cls not in classes:
        return f"{feature} has no class {cls}."
    graph = flow.load_graph(camera)
    if box not in graph["nodes"]:
        return f"Unknown box: {box}"
    kind = flow.kind_of(box)
    if flow.roi_step(camera, feature) == 2 and kind not in flow.PILES:
        return f"{feature} is a step-2 Classifier: its class dots take Ingest OK and Ingest NG."
    if kind in flow.PILES:
        if flow.roi_step(camera, feature) != 2:
            return f"{box} feeds a step-2 Classifier: make the Classifier in the Step 2 tab."
        if dot:
            return f"Use {box}'s main dot."
        if flow.PILE_CLASS[kind] != cls:
            return f"{box} holds {flow.PILE_CLASS[kind]} pictures, not {cls}."
        return None
    if kind == "evaluation":
        if dot not in flow.VERDICT_CLASS:
            return "Drag from the Evaluation's pass or fail dot: the all dot has no single class. Use it on the Classifier's main input to label OK and NG at once."
        if flow.VERDICT_CLASS[dot] != cls:
            return f"The Evaluation's {dot} dot is {flow.VERDICT_CLASS[dot]}, not {cls}."
        return None
    if kind == "dedup":
        src = flow.node_source(graph, box)
        if src and src["feature"] == feature:
            return f"{box} reads {feature}, so it cannot feed it back."
        carried = meaning(camera, box, graph)
        if carried is None:
            return f"{box} has no class to give: feed it from an Evaluation's pass or fail dot or from one class dot of a Classifier. Use the Classifier's main input for it as it is."
        if carried != cls:
            return f"{box} carries {carried} pictures, not {cls}."
        return None
    return "Only an Evaluation's pass or fail dot, a Dedup box or (in step 2) Ingest OK / NG can feed a class dot."


def add(camera: str, feature: str, cls: str, box: str, dot: str | None = None) -> None:
    problem = check(camera, feature, cls, box, dot)
    if problem:
        raise ClassLineError(problem)
    row = {"class": cls, "box": box, **({"dot": dot} if dot else {})}
    rows = [r for r in get(camera, feature) if r != row]
    rows.append(row)
    _save(camera, feature, rows)


def remove(camera: str, feature: str, cls: str, box: str, dot: str | None = None) -> None:
    row = {"class": cls, "box": box, **({"dot": dot} if dot else {})}
    _save(camera, feature, [r for r in get(camera, feature) if r != row])


def drop_box(camera: str, box: str) -> list[str]:
    """A box was deleted: forget the lines that came from it. Returns the Classifiers that lost a line."""
    touched = []
    for roi in datamodel.load_rois(camera):
        raw = db.get_setting(camera, f"{KEY}{roi.name}")
        if not raw:
            continue
        try:
            stored = json.loads(raw)
        except ValueError:
            continue
        kept = [r for r in stored if r.get("box") != box]
        if len(kept) != len(stored):
            _save(camera, roi.name, kept)
            touched.append(roi.name)
    return touched


def boxes(camera: str, feature: str) -> list[str]:
    """The Dedup boxes with a line into this Classifier's class dots (their mutes hide pictures here)."""
    return sorted({ln["box"] for ln in get(camera, feature) if flow.kind_of(ln["box"]) == "dedup"})


def _line_frames(camera: str, ln: dict, graph: dict, live: set[str]) -> set[str]:
    if flow.kind_of(ln["box"]) == "evaluation":
        return {f for f in flow.verdict_frames(camera, ln["box"], ln.get("dot") or "") if f in live}
    names = set(flow.node_frames(camera, ln["box"], graph)) & live
    return names - db.muted_frames(camera, ln["box"]) if flow.kind_of(ln["box"]) == "dedup" else names  # a Dedup box passes what it did not mute


@applog.timed("class_lines.by_class")
def by_class(camera: str, feature: str) -> dict[str, set[str]]:
    """class -> the pictures its dot receives (every line into the dot must pass a picture). Empty without lines."""
    return datamodel._snapshot_value(("class_by_class", camera, feature), lambda: _by_class(camera, feature))


def _by_class(camera: str, feature: str) -> dict[str, set[str]]:
    stored = effective(camera, feature)
    if not stored:
        return {}
    graph = flow.load_graph(camera)
    live = set(flow._live_frames(camera))
    out: dict[str, set[str]] = {}
    for ln in stored:
        names = _line_frames(camera, ln, graph, live)
        out[ln["class"]] = names if ln["class"] not in out else out[ln["class"]] & names
    return out


def conflicts(camera: str, feature: str, sets: dict[str, set[str]] | None = None) -> set[str]:
    """Pictures that reach two class dots."""
    sets = by_class(camera, feature) if sets is None else sets
    seen: set[str] = set()
    both: set[str] = set()
    for names in sets.values():
        both |= seen & names
        seen |= names
    return both


def scope(camera: str, feature: str) -> set[str] | None:
    """The pictures the class dots give the Classifier, or ``None`` when no line goes into a class dot."""
    sets = by_class(camera, feature)
    if not sets:
        return None
    every = set().union(*sets.values())
    return every - conflicts(camera, feature, sets)


def desired(camera: str, feature: str) -> dict[str, str]:
    """picture -> class for the pictures the class dots give (conflicting pictures have none)."""
    sets = by_class(camera, feature)
    out: dict[str, str] = {}
    both = conflicts(camera, feature, sets)
    for cls, names in sets.items():
        for f in names:
            if f not in both:
                out[f] = cls
    return out
