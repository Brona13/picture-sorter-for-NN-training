#!/usr/bin/env bash
#
# Launch Picture Sorter (FastAPI backend + built React frontend) from this
# project's virtual environment.
#
# Usage:
#   ./run.sh                    # serve the app on http://127.0.0.1:8999
#   ./run.sh --port 8510        # extra arguments go to uvicorn
#   ./run.sh dev                # backend with auto-reload (8999) + Vite dev server (5173)
#   ./run.sh build              # (re)build the frontend only
#
# The server binds 127.0.0.1 by default. Do not expose it to a network: the
# folder-import endpoint reads any directory path the caller names, and there is
# no authentication.
#
# Environment: .venv-rocm if present, else .venv (override with
# PICTURE_SORTER_VENV=.venv).
#
# Calling the venv's python by path avoids the failure where a system-wide
# Python without cv2/skimage serves a page and then fails inside it.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# Prefer the AMD ROCm environment when it exists (Linux GPU build); otherwise
# the default CPU .venv. PICTURE_SORTER_VENV=.venv forces the CPU environment.
if [ -n "${PICTURE_SORTER_VENV:-}" ]; then
    VENV_NAME="$PICTURE_SORTER_VENV"
elif [ -x "$PROJECT_ROOT/.venv-rocm/bin/python" ]; then
    VENV_NAME=".venv-rocm"
else
    VENV_NAME=".venv"
fi
VENV_PYTHON="$PROJECT_ROOT/$VENV_NAME/bin/python"
BACKEND_DIR="$PROJECT_ROOT/app/backend"
FRONTEND_DIR="$PROJECT_ROOT/app/frontend"

if [ ! -x "$VENV_PYTHON" ]; then
    echo "No virtual environment found at $VENV_NAME/" >&2
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
    echo "    $VENV_NAME/bin/pip install -r requirements.txt" >&2
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
            --host 127.0.0.1 --port 8999 --reload --reload-dir "$BACKEND_DIR" "$@" &
        backend_pid=$!
        trap 'kill "$backend_pid" 2>/dev/null || true' EXIT INT TERM
        (cd "$FRONTEND_DIR" && npm run dev)
        ;;
    serve)
        if [ ! -f "$FRONTEND_DIR/dist/index.html" ]; then
            echo "Frontend not built yet - building it first..." >&2
            build_frontend
        fi
        # The start-up screen (startup.py) replaces uvicorn's own start-up and per-request lines in the terminal;
        # every request is still in data/logs/ and on the Log page. PICTURE_SORTER_VERBOSE=1 brings them back.
        port=8999
        args=("$@")
        for i in "${!args[@]}"; do
            [ "${args[$i]}" = "--port" ] && port="${args[$((i + 1))]:-8999}"
        done
        export PICTURE_SORTER_URL="http://127.0.0.1:$port"
        quiet=(--log-level warning)
        [ -n "${PICTURE_SORTER_VERBOSE:-}" ] && quiet=()
        echo "Using $VENV_NAME" >&2
        exec "$VENV_PYTHON" -m uvicorn api.main:app --app-dir "$BACKEND_DIR" \
            --host 127.0.0.1 --port 8999 ${quiet[@]+"${quiet[@]}"} "$@"
        ;;
esac
