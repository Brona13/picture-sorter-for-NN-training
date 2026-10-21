"""Application version and release date — the single place to bump on a release.

Shown in the UI sidebar via ``GET /api/version``. Use an ISO date (YYYY-MM-DD).

Version scheme:
- 0.x.y — the Streamlit generation (retired).
- 1.x.y — the current FastAPI + React application.

Bump on every code change: the last number (1.0.2 -> 1.0.3) for small fixes and
tweaks, the middle number (1.0.x -> 1.1.0) for new features or behavior changes.
"""
from __future__ import annotations

VERSION = "1.84.2"
RELEASED = "2026-10-21"
