"""Free-text tags on a camera (a project), kept in the ``settings`` table under key ``tags``.

Tags only describe and filter cameras on the Overview page. They never touch frames, labels or scoring.
Matching is case-insensitive; the first spelling used is kept.
"""
from __future__ import annotations

import json
import re

import db

SETTING_KEY = "tags"
MAX_TAGS = 20
MAX_LEN = 40


class TagError(ValueError):
    """A tag list that cannot be stored."""


def clean(tags: list[str]) -> list[str]:
    """Trim, collapse inner whitespace, drop blanks and case-insensitive repeats; keep order."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in tags:
        if not isinstance(raw, str):
            raise TagError("Tags must be text.")
        tag = re.sub(r"\s+", " ", raw).strip()
        if not tag:
            continue
        if len(tag) > MAX_LEN:
            raise TagError(f"A tag can have at most {MAX_LEN} characters.")
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
    if len(out) > MAX_TAGS:
        raise TagError(f"A camera can have at most {MAX_TAGS} tags.")
    return out


def get(camera: str) -> list[str]:
    try:
        value = json.loads(db.get_setting(camera, SETTING_KEY, "[]") or "[]")
    except ValueError:
        return []
    return [t for t in value if isinstance(t, str)] if isinstance(value, list) else []


def set_tags(camera: str, tags: list[str]) -> list[str]:
    cleaned = clean(tags)
    db.set_setting(camera, SETTING_KEY, json.dumps(cleaned, ensure_ascii=False))
    return cleaned


def all_tags(cameras: list[str]) -> list[dict]:
    """Every tag used by the given cameras with how many cameras carry it, most used first."""
    spelling: dict[str, str] = {}
    count: dict[str, int] = {}
    for camera in cameras:
        for tag in get(camera):
            key = tag.casefold()
            spelling.setdefault(key, tag)
            count[key] = count.get(key, 0) + 1
    return [
        {"tag": spelling[k], "count": n}
        for k, n in sorted(count.items(), key=lambda kv: (-kv[1], spelling[kv[0]].casefold()))
    ]
