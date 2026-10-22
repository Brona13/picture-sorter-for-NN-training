"""Page sizes of the picture grids: whole rows only, so the last row of a full page is never half empty.

A page holds 2, 4, 8 or 16 rows of the chosen number of columns (6 columns: 12, 24, 48, 96; 5 columns: 10, 20, 40, 80).
"""
from __future__ import annotations

ROWS = (2, 4, 8, 16)
COLS = (3, 4, 5, 6, 8)


def per_page_options(cols: int) -> list[int]:
    return [cols * r for r in ROWS]


def all_per_page() -> list[int]:
    """Every page size that is valid for some column count (what a stored or requested size is checked against alone)."""
    return sorted({c * r for c in COLS for r in ROWS})


def is_valid(per_page: int, cols: int) -> bool:
    return cols in COLS and per_page in per_page_options(cols)
