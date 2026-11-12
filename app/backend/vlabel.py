"""The one way a version number is written: ``V01``, ``V02`` ... ``V99``, ``V100`` (two digits at least, capital V; v1.161.0).

Versions made before v1.161.0 keep what they were given: names stored as ``v1`` and files / folders named ``v001`` stay as they are.
"""
from __future__ import annotations


def label(number: int) -> str:
    return f"V{int(number):02d}"
