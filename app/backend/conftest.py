"""Put app/backend on sys.path so flat imports (``import config``) work in tests."""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


import scatter  # noqa: E402

scatter._warm_started = True  # tests never start the background UMAP warm-up
