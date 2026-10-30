# Launch Picture Sorter (FastAPI backend + built React frontend) from this
# project's virtual environment. Windows/PowerShell counterpart of run.sh.
#
# Usage (from any directory):
#   .\run.ps1                   # serve the app on http://127.0.0.1:8999
#   .\run.ps1 --port 8510       # extra arguments go to uvicorn
#   .\run.ps1 dev               # backend with auto-reload (8999) + Vite dev server (5173)
#   .\run.ps1 build             # (re)build the frontend only
#
# If PowerShell refuses to run the script (execution policy), either run
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# once, or start it as
#   powershell -ExecutionPolicy Bypass -File .\run.ps1
#
# The server binds 127.0.0.1 by default. Do not expose it to a network: the
# folder-import endpoint reads any directory path the caller names, and there is
# no authentication.
#
# Calling the venv's python by path avoids the failure where a system-wide
# Python without cv2/skimage serves a page and then fails inside it.

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$VenvPython  = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$BackendDir  = Join-Path $ProjectRoot "app\backend"
$FrontendDir = Join-Path $ProjectRoot "app\frontend"
$Port        = 8999

if (-not (Test-Path $VenvPython)) {
    Write-Error @"
No virtual environment found at .venv\

The environment is machine-specific and is never cloned. Create it:
    python -m venv .venv
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt
"@
}

# Fail with a readable message rather than a traceback inside the server.
$check = "import importlib.util as u; req={'cv2':'opencv-python','skimage':'scikit-image','numpy':'numpy','PIL':'pillow','fastapi':'fastapi','uvicorn':'uvicorn','multipart':'python-multipart'}; print(' '.join(d for m,d in req.items() if u.find_spec(m) is None))"
$missing = "$(& $VenvPython -c $check)".Trim()
if ($missing) {
    Write-Error @"
The virtual environment is missing required packages:
    $missing

Install them with:
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt
"@
}

function Require-Npm {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Error "npm (Node.js 20+) is required to build the frontend: https://nodejs.org"
    }
}

function Build-Frontend {
    Require-Npm
    Push-Location $FrontendDir
    try {
        if (-not (Test-Path "node_modules")) { npm install; if ($LASTEXITCODE) { throw "npm install failed" } }
        npm run build
        if ($LASTEXITCODE) { throw "npm run build failed" }
    } finally { Pop-Location }
}

$mode = "serve"
$rest = @($args)
if ($rest.Count -gt 0 -and @("dev", "build") -contains $rest[0]) {
    $mode = $rest[0]
    $rest = @($rest | Select-Object -Skip 1)
}

$uvicorn = @("-m", "uvicorn", "api.main:app", "--app-dir", $BackendDir, "--host", "127.0.0.1", "--port", "$Port")

switch ($mode) {
    "build" {
        Build-Frontend
    }
    "dev" {
        Require-Npm
        if (-not (Test-Path (Join-Path $FrontendDir "node_modules"))) {
            Push-Location $FrontendDir; try { npm install } finally { Pop-Location }
        }
        # Start-Process joins arguments without quoting, so quote paths (they may contain spaces).
        $devArgs = @("-m", "uvicorn", "api.main:app", "--app-dir", "`"$BackendDir`"", "--host", "127.0.0.1",
                     "--port", "$Port", "--reload", "--reload-dir", "`"$BackendDir`"") + $rest
        $backend = Start-Process -FilePath $VenvPython -NoNewWindow -PassThru -ArgumentList $devArgs
        try {
            Push-Location $FrontendDir
            try { npm run dev } finally { Pop-Location }
        } finally {
            if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id -Force }
        }
    }
    default {
        if (-not (Test-Path (Join-Path $FrontendDir "dist\index.html"))) {
            Write-Host "Frontend not built yet - building it first..."
            Build-Frontend
        }
        # The start-up screen (startup.py) replaces uvicorn's own start-up and per-request lines in the terminal;
        # every request is still in data\logs\ and on the Log page. PICTURE_SORTER_VERBOSE=1 brings them back.
        $port = $Port
        for ($i = 0; $i -lt $rest.Count - 1; $i++) {
            if ($rest[$i] -eq "--port") { $port = $rest[$i + 1] }
        }
        $env:PICTURE_SORTER_URL = "http://127.0.0.1:$port"
        $quiet = @("--log-level", "warning")
        if ($env:PICTURE_SORTER_VERBOSE) { $quiet = @() }
        & $VenvPython @uvicorn @quiet @rest
        exit $LASTEXITCODE
    }
}
