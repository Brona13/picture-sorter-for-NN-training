"""A sample is one picture of a Classifier that reads a detector target with several elements.

A target that looks for N similar elements gives N boxes per picture. A Classifier anchored on all of them works on N
times as many pictures: one per box. Such a sample goes by ``<file>#<n>`` (``part_017.png#2`` = box 2 of that file).
Ingested file names never contain ``#`` (``ingest._sanitize`` turns it into ``_``), so the id cannot clash with a file.
Everything that keys by picture (labels, goldens, bin, mutes) takes the id as an opaque name; what needs the file or the
box splits it here.
"""
from __future__ import annotations

import re

_SAMPLE = re.compile(r"^(.+)#(\d{1,2})$")


def split(frame: str) -> tuple[str, int | None]:
    """``("part.png", 2)`` for ``part.png#2``; ``(frame, None)`` for a plain file name."""
    m = _SAMPLE.match(frame)
    return (m.group(1), int(m.group(2))) if m else (frame, None)


def file_of(frame: str) -> str:
    return split(frame)[0]


def make(file: str, number: int) -> str:
    return f"{file}#{number}"


def label(frame: str) -> str:
    """How a sample is shown to a person: ``part.png · box 2``."""
    file, n = split(frame)
    return file if n is None else f"{file} · box {n}"


class HashMap(dict):
    """file name -> content hash that also answers for sample ids: ``part.png#2`` -> ``<hash>#2``."""

    def get(self, key, default=None):  # noqa: D401
        found = dict.get(self, key)
        if found is not None or not isinstance(key, str):
            return found if found is not None else default
        file, n = split(key)
        base = dict.get(self, file) if n is not None else None
        return f"{base}#{n}" if base else default

    def __getitem__(self, key):
        found = self.get(key)
        if found is None:
            raise KeyError(key)
        return found

    def __contains__(self, key):
        return self.get(key) is not None
