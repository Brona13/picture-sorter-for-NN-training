#!/usr/bin/env bash
#
# Launch Picture Sorter (FastAPI backend + built React frontend) from this
# project's virtual environment.
#
# Usage:
#   ./run.sh                    # serve the app on http://127.0.0.1:8000
#   ./run.sh --port 8510        # extra arguments go to uvicorn
#   ./run.sh dev                # backend with auto-reload (8000) + Vite dev server (5173)
#   ./run.sh build              # (re)build the frontend only
#
# The server binds 127.0.0.1 by default. Do not expose it to a network: the
# folder-import endpoint reads any directory path the caller names, and there is
# no authentication.
#
# Calling the venv's python by path avoids the failure where a system-wide
# Python without cv2/skimage serves a page and then fails inside it.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

VENV_PYTHON="$PROJECT_ROOT/.venv/bin/python"
BACKEND_DIR="$PROJECT_ROOT/app/backend"
FRONTEND_DIR="$PROJECT_ROOT/app/frontend"

if [ ! -x "$VENV_PYTHON" ]; then
    echo "No virtual environment found at .venv/" >&2
    echo >&2
    echo "The environment is machine-specific and is never cloned. Create it:" >&2
    echo "    python3 -m venv .venv" >&2
    echo "    .venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi

missing="$("$VENV_PYTHON" - <<'PY'
import importlib.util
required = {
    "cv2": "opencv-python",
    "skimage": "scikit-image",
    "numpy": "numpy",
    "PIL": "pillow",
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "multipart": "python-multipart",
}
print(" ".join(dist for mod, dist in required.items()
                if importlib.util.find_spec(mod) is None))
PY
)"
if [ -n "$missing" ]; then
    echo "The virtual environment is missing required packages:" >&2
    echo "    $missing" >&2
    echo >&2
    echo "Install them with:" >&2
    echo "    .venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi

need_npm() {
    if ! command -v npm >/dev/null 2>&1; then
        echo "npm (Node.js 20+) is required to build the frontend: https://nodejs.org" >&2
        exit 1
    fi
}

build_frontend() {
    need_npm
    (cd "$FRONTEND_DIR" && { [ -d node_modules ] || npm install; } && npm run build)
}

mode="serve"
case "${1:-}" in
    dev|build) mode="$1"; shift ;;
esac

case "$mode" in
    build)
        build_frontend
        ;;
    dev)
        need_npm
        [ -d "$FRONTEND_DIR/node_modules" ] || (cd "$FRONTEND_DIR" && npm install)
        "$VENV_PYTHON" -m uvicorn api.main:app --app-dir "$BACKEND_DIR" \
            --host 127.0.0.1 --port 8000 --reload --reload-dir "$BACKEND_DIR" "$@" &
        backend_pid=$!
        trap 'kill "$backend_pid" 2>/dev/null || true' EXIT INT TERM
        (cd "$FRONTEND_DIR" && npm run dev)
        ;;
    serve)
        if [ ! -f "$FRONTEND_DIR/dist/index.html" ]; then
            echo "Frontend not built yet - building it first..." >&2
            build_frontend
        fi
        exec "$VENV_PYTHON" -m uvicorn api.main:app --app-dir "$BACKEND_DIR" \
            --host 127.0.0.1 --port 8000 "$@"
        ;;
esac
