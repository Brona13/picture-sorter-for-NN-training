"""Which scoring methods take part in the flow (one global choice, edited on the Configuration page).

The three methods are the classical ``cpu`` family and the ``resnet18`` / ``resnet50`` embeddings. A method
that is switched off is not computed (no vectors, no comparisons), is left out of Classify, Insights, version
statistics and the card flags, and cannot be picked in Dedup, Outliers, Find similar or golden suggestions.
Nothing is deleted: vectors already cached stay valid, so switching a method back on only needs a refresh.

The choice is app-wide, stored in the ``settings`` table under a reserved pseudo-camera. It never leaves
fewer than one method: when the saved choice names nothing that is installed, every installed method is used.
"""
from __future__ import annotations

import json

import db
import embedding

ALL_METHODS = ["cpu", "resnet18", "resnet50"]
SETTING_CAMERA = "_global"  # the settings table is keyed by camera; this row holds app-wide settings
SETTING_KEY = "methods.active"

INFO = {
    "cpu": {
        "label": "CPU (classical)",
        "tag": "CPU",
        "description": "Colour histogram, pixel difference (MSE) and SSIM on the cutout; no model needed.",
    },
    "resnet18": {
        "label": "ResNet18",
        "tag": "R18",
        "description": "Pretrained ResNet18 embeddings compared by cosine distance; the faster neural method.",
    },
    "resnet50": {
        "label": "ResNet50",
        "tag": "R50",
        "description": "Pretrained ResNet50 embeddings compared by cosine distance; the default ranking method.",
    },
}


def installed() -> list[str]:
    """Methods this installation can run: the classical family always, the ResNets when PyTorch is present."""
    return ["cpu", *embedding.backbones()]


def _saved() -> list[str] | None:
    raw = db.get_setting(SETTING_CAMERA, SETTING_KEY)
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return [m for m in data if isinstance(m, str)] if isinstance(data, list) else None


def active() -> list[str]:
    """The methods in use, in the fixed order cpu, resnet18, resnet50 (never empty)."""
    have = installed()
    chosen = _saved()
    if chosen is None:
        return have
    return [m for m in have if m in chosen] or have


def active_backbones() -> list[str]:
    """The active neural methods (the embeddings that Dedup, Outliers and Find similar can use)."""
    return [m for m in active() if m != "cpu"]


def set_active(methods: list[str]) -> list[str]:
    """Save the choice; returns the methods now in use. Raises ``ValueError`` for an unknown or empty choice."""
    unknown = [m for m in methods if m not in ALL_METHODS]
    if unknown:
        raise ValueError(f"Unknown method: {', '.join(unknown)}")
    have = installed()
    chosen = [m for m in have if m in methods]
    if not chosen:
        raise ValueError("Keep at least one method switched on.")
    db.set_setting(SETTING_CAMERA, SETTING_KEY, json.dumps(chosen))
    return chosen


def describe() -> list[dict]:
    """Every method with its label, whether it can run here, and whether it is switched on."""
    have = installed()
    on = active()
    return [
        {
            "id": m,
            **INFO[m],
            "installed": m in have,
            "active": m in on,
            "reason": None if m in have else "PyTorch is not installed (pip install -r requirements-embedding.txt).",
        }
        for m in ALL_METHODS
    ]
