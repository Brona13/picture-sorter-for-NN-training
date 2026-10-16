"""Per-method confusion matrices of scored leanings vs the user's labels.

Rows are the ground-truth class (the user's label), columns are the method's
leaning. Goldens are the reference set and are excluded, so accuracy is measured
on held-out labelled frames.
"""
from __future__ import annotations


def evaluable_labels(lab: dict[str, str], gold: dict[str, list[str]]) -> dict[str, str]:
    """Labels of frames that are not goldens (a leaning against your own reference is meaningless)."""
    golden_frames = {f for frames in gold.values() for f in frames}
    return {f: c for f, c in lab.items() if f not in golden_frames}


def build_matrix(results, evaluable: dict[str, str], classes: list[str], method: str):
    """``({true: {pred: count}}, skipped)``; ``skipped`` = held-out frames the method
    couldn't give a leaning for (not scored, or only one class has goldens)."""
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


def cell_frames(results, evaluable: dict[str, str], method: str, true_c: str, pred_c: str) -> list[str]:
    """Frames counted in one matrix cell (same rule as ``build_matrix``), sorted by name."""
    out = []
    for fs in results:
        if evaluable.get(fs.frame) != true_c:
            continue
        ms = fs.per_method.get(method)
        if ms is not None and ms.leaning == pred_c:
            out.append(fs.frame)
    return sorted(out)


def summarize(matrix: dict[str, dict[str, int]], classes: list[str]) -> dict:
    correct = sum(matrix[c][c] for c in classes)
    total = sum(matrix[t][p] for t in classes for p in classes)
    return {"correct": correct, "total": total, "accuracy": (correct / total * 100) if total else 0.0}
