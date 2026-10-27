# Machines: what runs where

Created 2026-10-22. Facts are from checks in the chat unless marked *(from project docs)*. Unknown values are marked **?**.

## Overview

| Machine | Role | OS | GPU | Torch build | Python | Network |
|---|---|---|---|---|---|---|
| Work laptop (HP ZBook Fury G8) | Daily use at work | Windows | NVIDIA RTX A2000 Laptop, 4 GB | 2.11.0+cu128, CUDA works | **?** (check venv) | Work, proxy `localhost:9001` |
| VR PC (SKDAMBWG3277) | Candidate heavy-work server | Windows 11 Enterprise 10.0.26100 | NVIDIA RTX A5000, 24 GB | none yet | none installed | Work, domain, 10.217.42.108 |
| Home Linux workstation | Development only | Linux | AMD RX 7800 XT (gfx1101) | 2.14.1+rocm7.2 in `.venv-rocm` *(docs)* | **?** | Direct, no proxy |
| Lenovo Legion (brona-legion) | Local dev only | Windows | AMD RX 6600M + AMD integrated | none (CPU build would apply) | 3.11.2 | Home Wi-Fi 10.129.224.215, workgroup |

## Work laptop (HP ZBook Fury G8)

- CPU i7-11850H (8 cores / 16 threads), about 63 GB RAM.
- GPU RTX A2000 Laptop, 4 GB VRAM, driver 573.86, CUDA 12.8. The newer cu130 builds are therefore not an option.
- venv with PyTorch 2.11.0+cu128, `torch.cuda.is_available()` True (checked 2026-10-21).
- Project path: `C:\Brona\Python\picture-sorter-for-NN-training` (git repo on `main`).
- Network: pypi.org and github.com are not reachable directly. pip works through `--proxy http://localhost:9001`, and git through `git config http.proxy http://localhost:9001` (set in the repo).
- No Node.js/npm: the frontend arrives as a version-named dist zip.
- Delivery: version-named `git am` patch plus `frontend-dist-vX.Y.Z.zip`.
- Git: the user applies the patch (`git am`), commits and pushes himself, through the proxy above. Claude cannot push.

## VR PC (work, checked 2026-10-22)

- Name SKDAMBWG3277, Windows 11 Enterprise 10.0.26100, domain `skoda.vwg`, network profile DomainAuthenticated.
- CPU Intel Xeon w5-3435X (16 cores), 512 GB RAM.
- GPU NVIDIA RTX A5000, 24564 MiB, driver 537.70, CUDA 12.2. 645 MiB used by the desktop at idle. The cu128 torch build does not fit this driver. `torch 2.5.1+cu121` fits (supports Python 3.9 to 3.12). **Not tested.**
- Disk: C: 10 GB free (too little), D: 6.7 TB free, G: 409 GB free. Project, venv and caches must go on D:.
- Python: not installed. `python.exe` is only the Microsoft Store stub. `py` launcher missing. `winget` v1.29.380 present.
- User not elevated (not admin). A driver update or firewall rule would need admin/IT.
- Proxy: PAC at `http://127.0.0.1:9001/localproxy-ff564109.pac`, port 9001 listening locally. Direct 443 to pypi.org, files.pythonhosted.org, download.pytorch.org, github.com and www.python.org fails (expected, must go through the proxy). **Not tested through the proxy.**
- Firewall: Domain and Public profiles on, Private off. Zscaler (ZSATray) is running, which may restrict traffic between PCs.
- IP 10.217.42.108 (Ethernet 2). Another adapter has link-local 169.254.126.2.
- Power: sleep on AC set to never. Screen off after 15 minutes on AC. It stays on unless switched off by someone.
- VR software: HTC Vive services and an XR runtime service are running. GPU conflict only during an active VR session.
- Other: Citrix, Teams, Chrome and Edge are installed.

### Open checks for the VR PC
1. Through the proxy: pypi.org, download.pytorch.org, python.org, github.com (curl.exe with `-x http://localhost:9001`).
2. Can the work laptop reach the VR PC on a test port (TcpListener on 8765, then `Test-NetConnection 10.217.42.108 -Port 8765` from the laptop)?
3. Any way to elevate (separate admin account or IT)?
4. May a process be left running there, and who else uses the PC?
5. Python install route without admin (python.org per-user installer or winget) and the version. 3.11 or 3.12 for torch 2.5.1.

## Home Linux workstation *(from project docs)*

- Development platform. AMD RX 7800 XT (gfx1101), ROCm, `.venv-rocm` (git-ignored, preferred by `run.sh`; `PICTURE_SORTER_VENV=.venv` forces the CPU venv).
- torch 2.14.1+rocm7.2, no `HSA_OVERRIDE_GFX_VERSION` needed.
- Measured: resnet18 about 678 frames/s vs 163 on CPU, resnet50 about 405 vs 59, OWL-ViT about 95 ms/frame vs 367 on CPU.
- npm is installed: `./run.sh build`, then `./run.sh`. Direct network, no proxy.
- Git: SSH key, the user commits and pushes straight to `main` after almost every change. Claude cannot push.
- Python version and project path: **?** (the Linux project path in `docs/workflow.md` is still unfilled).

## Lenovo Legion (brona-legion, checked 2026-10-22)

- Local development only. Windows, workgroup (not a work machine).
- GPU AMD RX 6600M (driver 32.0.21043.19003) plus AMD integrated graphics. On Windows, AMD means the CPU torch build for the app.
- Python 3.11.2 (64-bit) at `C:\Users\broni\AppData\Local\Programs\Python\Python311`, `py` launcher present, pip present.
- No picture-sorter project and no venv found under C: (no `C:\Brona\Python`).
- Network: Wi-Fi 10.129.224.215, network "Flip8", profile Public. Cannot reach the VR PC (not on the work network).

## Constraints that affect the VR PC idea

- Torch build must match the driver: CUDA 12.2 on the VR PC (cu121 build or a driver update), CUDA 12.8 on the work laptop (cu128).
- The app has only run on torch 2.11 (laptop) and 2.14 (ROCm). Torch 2.5.1 on the VR PC is untested.
- The backend currently binds `127.0.0.1` and has no authentication. Running it on the VR PC needs a listening address, and the work network and firewall decide whether the laptop can reach it.
- The VR PC may be off. The laptop must keep working with its own local backend, with a Configuration setting for the backend address and an alive test.
- Syncing: pictures are immutable (SHA-256) and easy to copy. Curation state is mutable, so one owner per camera with push/pull is the safer model. Goldens are the data worth keeping.
