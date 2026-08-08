"""Insights view — per-method confusion matrices vs the user's labels.

Rows are the ground-truth class (the user's label), columns are the method's
leaning. ⭐ goldens are the reference set and are excluded from evaluation, so
"accuracy" here is measured on the held-out labelled frames.
"""
from __future__ import annotations

import streamlit as st

import classify
import datamodel
import labels
import ui_common


def render(camera: str, product: str | None = None) -> None:
    st.header(f"Insights — {camera}" + (f" › {product}" if product else ""))

    feature = ui_common.feature_picker(camera, product)

    classes = datamodel.classes_for(camera, feature)
    gold = labels.current_goldens(camera, feature)
    lab = labels.current_labels(camera, feature)
    methods = classify.methods_available()

    # Goldens are references, not test data — a leaning against your own reference
    # would be meaningless. Held-out labels = every other labelled frame.
    golden_frames = {f for frames in gold.values() for f in frames}
    evaluable = {f: c for f, c in lab.items() if f not in golden_frames}

    have_goldens = [c for c in classes if gold.get(c)]
    if len(have_goldens) < 2:
        st.info(
            f"A confusion matrix needs goldens in at least two classes so the methods "
            f"can produce a leaning. Currently only **{'/'.join(have_goldens) or 'none'}** "
            "has references — add another in **Classify**, refresh, and come back."
        )
        return
    if not evaluable:
        st.info(
            "No held-out labelled frames yet — every label is currently a ⭐golden. "
            "Label some non-golden frames in **Classify** and come back."
        )
        return

    key = f"insights::{camera}::{feature}"
    progress = None
    c1, c2 = st.columns([1, 3])
    if c1.button("🔄 Compute matrices", type="primary"):
        progress = ui_common.ScoringProgressUI("Computing insight matrices…")
        try:
            st.session_state[key] = classify.refresh(
                camera, feature, phase_progress_cb=progress,
            )
        except Exception:
            progress.error("Matrix scoring failed")
            raise
        progress.update("presentation", 0, 1, detail="matrices")
    c2.caption(
        f"Rows = your label · columns = method's leaning · {len(evaluable)} held-out "
        "frames · ⭐ goldens excluded."
    )

    results = st.session_state.get(key)
    if results is None:
        st.caption("Click **Compute matrices** to score frames and render the matrices.")
        return

    cols = st.columns(len(methods))
    for col, method in zip(cols, methods):
        with col:
            st.markdown(f"**{method}**")
            matrix, skipped = _build_matrix(results, evaluable, classes, method)
            _render_matrix(matrix, classes)
            correct = sum(matrix[c][c] for c in classes)
            total = sum(matrix[t][p] for t in classes for p in classes)
            acc = (correct / total * 100) if total else 0.0
            note = f" · {skipped} unscored" if skipped else ""
            st.caption(f"Accuracy **{acc:.1f}%** ({correct}/{total}){note}")
    if progress is not None:
        progress.complete("Insight matrices ready")


def _build_matrix(results, evaluable, classes, method):
    """Return ({true: {pred: count}}, skipped) — skipped = held-out frames the
    method couldn't produce a leaning for (missing per_method, or leaning None
    because only one class has goldens for that specific method)."""
    matrix = {t: {p: 0 for p in classes} for t in classes}
    skipped = 0
    class_set = set(classes)
    for fs in results:
        true_c = evaluable.get(fs.frame)
        if true_c is None:
            continue
        ms = fs.per_method.get(method)
        pred_c = ms.leaning if ms else None
        if pred_c is None:
            skipped += 1
            continue
        if true_c in class_set and pred_c in class_set:
            matrix[true_c][pred_c] += 1
    return matrix, skipped


def _render_matrix(matrix, classes):
    def cell(t, p, val):
        if val == 0:
            style = "background:transparent;color:var(--text-muted)"
        elif t == p:
            style = "background:#C0DD97;color:#173404"
        else:
            style = "background:#F7C1C1;color:#501313"
        return (
            f"<td style='{style};padding:4px 8px;text-align:center;"
            f"border-radius:3px;min-width:32px'>{val}</td>"
        )
    hdr_style = "padding:2px 6px;color:#888;font-weight:normal;font-size:11px"
    header = "".join(f"<th style='{hdr_style}'>pred {c}</th>" for c in classes)
    rows = "".join(
        f"<tr><th style='{hdr_style};text-align:right'>true {t}</th>"
        + "".join(cell(t, p, matrix[t][p]) for p in classes)
        + "</tr>"
        for t in classes
    )
    st.markdown(
        f"<table style='border-collapse:separate;border-spacing:2px'>"
        f"<tr><th></th>{header}</tr>{rows}</table>",
        unsafe_allow_html=True,
    )
