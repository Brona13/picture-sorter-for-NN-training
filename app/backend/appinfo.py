"""Application version and release date — the single place to bump on a release.

Shown in the UI sidebar via ``GET /api/version``. Use an ISO date (YYYY-MM-DD).

Version scheme:
- 0.x.y — the Streamlit generation (retired).
- 1.x.y — the current FastAPI + React application.
"""
from __future__ import annotations

VERSION = "1.0.2"
RELEASED = "2026-10-14"
