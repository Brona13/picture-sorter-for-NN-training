#!/usr/bin/env bash
#
# Launch the curation app using this project's virtual environment.
#
# Calling the venv's launcher by path avoids the common failure where a
# system-wide `streamlit` earlier on PATH runs the app against a Python that
# lacks cv2 and skimage. Streamlit serves a page in that case and then fails
# inside it, which reads like an application bug rather than a missing
# environment.
#
# Usage:
#   ./run.sh                          # Streamlit picks a free port
#   ./run.sh --server.port 8510       # any extra arguments are passed through
#   ./run.sh --server.address 127.0.0.1   # keep the app off the network
#
# Note: Streamlit binds every interface by default.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

VENV_PYTHON="$PROJECT_ROOT/.venv/bin/python"
VENV_STREAMLIT="$PROJECT_ROOT/.venv/bin/streamlit"
APP="$PROJECT_ROOT/scripts/app.py"

if [ ! -x "$VENV_STREAMLIT" ]; then
    echo "No virtual environment found at .venv/" >&2
    echo >&2
    echo "The environment is machine-specific and is never cloned. Create it:" >&2
    echo "    python3 -m venv .venv" >&2
    echo "    .venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi

# Fail with a readable message rather than a traceback inside the browser.
missing="$("$VENV_PYTHON" - <<'PY'
import importlib.util
required = {
    "cv2": "opencv-python",
    "skimage": "scikit-image",
    "numpy": "numpy",
    "PIL": "pillow",
    "streamlit": "streamlit",
    "streamlit_drawable_canvas": "streamlit-drawable-canvas",
    "streamlit_js_eval": "streamlit-js-eval",
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

exec "$VENV_STREAMLIT" run "$APP" "$@"
