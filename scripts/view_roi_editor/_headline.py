"""HTML for one ROI card's headline row: thumbnail + name + scope chip + counts."""
from __future__ import annotations

import datamodel
import labels
import versions
from roi import ROI


def _chip(text: str, bg: str, fg: str) -> str:
    return (
        f"<span style='background:{bg};color:{fg};font-size:11px;padding:2px 8px;"
        f"border-radius:6px;white-space:nowrap'>{text}</span>"
    )


def roi_headline(
    camera: str,
    r: ROI,
    short: str,
    owner: str | None,
    thumb: str | None = None,
    inbox_total: int | None = None,
) -> str:
    """Thumbnail + name + scope chip + the counts that actually drive a decision."""
    import html

    if r.role == "classify":
        chip = _chip("🗂 product sorter", "#7a5b00", "#fff")
    elif r.products:
        chip = _chip("🔗 shared · " + ", ".join(r.products), "#185fa5", "#fff")
    elif owner:
        chip = _chip(f"{owner} only", "#0f6e56", "#fff")
    else:
        chip = _chip("all frames", "rgba(128,128,128,.25)", "inherit")

    classes = datamodel.classes_for(camera, r.name)
    counts = labels.counts(camera, r.name)
    labeled = sum(counts.get(c, 0) for c in classes)
    goldens = sum(counts.get(f"golden_{c}", 0) for c in classes)
    vl = versions.list_versions(camera, r.name)
    active = next((f"v{v['number']} active" for v in vl if v["active"]), None)

    # "135 of 207 frames" whenever the ROI sees only part of the inbox, so a
    # product-restricted count never silently contradicts the camera's total.
    seen = counts.get("total", 0)
    frames_txt = (
        f"{seen} of {inbox_total} frames"
        if inbox_total is not None and seen != inbox_total
        else f"{seen} frames"
    )
    meta = [
        frames_txt,
        f"{goldens} golden" + ("" if goldens == 1 else "s"),
        f"{labeled} labeled",
        active or "no version yet",
    ]

    box = "width:56px;height:56px;flex:none;border-radius:8px;background:rgba(128,128,128,.18)"
    img = (
        f"<img src='{thumb}' alt='' style='{box};object-fit:cover'>"
        if thumb
        else f"<div style='{box}'></div>"
    )
    return (
        f"<div style='display:flex;gap:10px;align-items:center'>{img}"
        f"<div style='min-width:0'>"
        f"<div style='display:flex;align-items:center;gap:8px;flex-wrap:wrap'>"
        f"<span style='font-size:15px;font-weight:600'>{html.escape(short)}</span>{chip}</div>"
        f"<div style='font-size:12px;opacity:.7;margin-top:2px'>{' · '.join(meta)}</div>"
        f"</div></div>"
    )
