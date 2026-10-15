---
name: gpu-backends-rocm
description: Per-machine PyTorch builds (CPU/CUDA/ROCm), AMD RX 7800 XT verified on Linux in .venv-rocm, v1.7.0
session_date: 2026-10-15
last_updated: 2026-10-15
status: current
document_type: session-note
metadata:
  type: project
---

# GPU backends and ROCm (v1.7.0)

## Decisions
- The project folder travels between machines; only the installed PyTorch wheel differs: CPU, Nvidia CUDA, or AMD ROCm (Linux only). Windows + AMD stays on the CPU build (no stable ROCm for Windows).
- Device selection code needed no change: ROCm and CUDA builds both answer `torch.cuda.is_available()`, so the device string is `"cuda"` for either. Added `embedding.torch_backend()` / `device_label()` so the UI names the vendor (`AMD GPU (ROCm)`), plus a hint when a GPU tool is on `PATH` but the CPU wheel is installed. APIs return `device_label`.
- `.venv` is untouched. The ROCm environment is a separate, git-ignored `.venv-rocm` (about 15 GB).

## Verified on the Linux dev machine
- Radeon RX 7800 XT (`gfx1101`), torch 2.14.1+rocm7.2; no `HSA_OVERRIDE_GFX_VERSION` needed; `/dev/kfd` present, user in `render` and `video`.
- 191 backend tests pass in `.venv-rocm`.
- 256 synthetic frames: resnet18 678 frames/s (CPU 163), resnet50 405 (CPU 59), embeddings identical (cosine 1.0). OWL-ViT detection 95 ms/frame (CPU 367 ms), same box.

## Not done / untested
- `setup_torch.sh` / `setup_torch.ps1` (detect hardware or ask, `--backend cpu|cuda|rocm`): planned, not built.
- Windows + Nvidia and Windows + AMD (CPU) not run in this session.
- `run.sh` still launches `.venv`; use `.venv-rocm` by activating it first.
- Flaky test: `test_clean_schema.py::MigrationV3ToV4Tests::test_parallel_first_connects_all_succeed` failed once in a full run, passes in isolation and on the previous code.

Related: [[goldens-export-versioning-gpu]], [[detector-masking]], [[handover-new-tools]].
