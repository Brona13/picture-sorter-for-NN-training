---
name: resnet-embedding-method
description: ResNet18 and ResNet50 embeddings as independent neural scoring methods
status: shipped
document_type: plan
last_updated: 2026-08-11
---

# Plan: ResNet embedding as an independent "neural" scoring method

> **Status — shipped.** Delivered in July 2026 (started 2026-07-16). `scripts/embedding.py`,
> `METRIC_FAMILIES` / `EMBEDDING_*` config, ResNet18 & ResNet50 backbones, `requirements-embedding.txt`
> as an optional install, and the neural-device caption in Classify are all in production; the
> torch-free CPU-only fallback still works. Companion to
> [smart-data-curation-plan.md](smart-data-curation-plan.md).
>
> **Drift note:** some of the file-level details below are stale relative to today's tree
> (`view_sort.py` was renamed to `view_classify/`, and `curation.CutoutFeatures` + related helpers
> were pruned as dead code in a later refactor pass) — the feature is delivered through the current
> `classify.py` / `embedding.py` pipeline instead.

## Context
The roadmap's open decision (see `smart-data-curation-plan.md` and `memory/flow-and-roadmap.md`) was whether to add a pretrained ResNet embedding as a stronger feature space. This implements it — **not** as a blended metric, but as an **independent scoring family** the user can switch to, alongside the existing classical metrics. Why: embeddings are robust to the slight frame-to-frame shift that weakens MSE, they align the tool's "eyes" with the target ResNet classifier, and they are groundwork for the later OK/NG QA. Scope = the **scoring method only** (not the QA feature).

**Design decisions (from the user):**
- Support **both ResNet18 and ResNet50**, chosen via a UI switch.
- Keep **two independent scoring families**, each its own weighted average — not blended:
  - **CPU family** = classical `{histogram, mse, ssim}` — unchanged, "as it is now".
  - **Neural (NN) family** = `{resnet18, resnet50, …}` embedding distances. A UI switch selects which family ranks the candidates; each family finds its own nearest golden.
- **Torch is an optional dependency.** Without it, only the CPU family appears and nothing breaks.

## Device / two-machine reality (confirmed)
- **Current laptop (Windows 11, AMD / integrated graphics only — no Nvidia):** CPU-only. Install: `pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu`.
- **HP laptop (later, Nvidia GPU):** install the matching CUDA build from pytorch.org → GPU auto.
- `EMBEDDING_DEVICE = "auto"` → `cuda` if `torch.cuda.is_available()` else `cpu`; UI shows the device; graceful CPU fallback so the same code runs on both machines — only the install differs.

## Design — metric families
Partition metrics into families, combine each independently (weighted average), compute novelty per family, and let the active family (UI switch) drive ranking. Each family finds its own nearest golden cutout.

### Files & changes
- **NEW `scripts/embedding.py`** (logic, lazy torch — importable without torch): `available()`, `active_device()`, cached `get_model(backbone)` (frozen pretrained, `fc=Identity`, eval, on the auto device), `embed(cutout_bgr, backbone) -> L2-normalized np.float32`, `cosine_distance()` in `[0,1]`. Backbones `resnet18`/`resnet50` via a small registry; preprocessing via the weights' own `.transforms()`.
- **`scripts/config.py`:** `METRIC_FAMILIES`, `DEFAULT_FAMILY`, `EMBEDDING_ENABLED`, `EMBEDDING_DEVICE`, `EMBEDDING_BACKBONES`; extend `METRIC_WEIGHTS` with `resnet18`/`resnet50`.
- **`scripts/curation.py`:** `CutoutFeatures.embeddings` dict; `extract_features(cutout, backbones=())`; `distance_between` adds each backbone's cosine distance when present; `combine(..., keys=None)`; `score_against_golden(candidate, golden, family="cpu")`; `build_golden_features(..., backbones=())`.
- **`scripts/engine.py`:** `score_unsorted(camera, feature, family="cpu", backbones=None, …)` — `Candidate` shape unchanged, so `apply_decision`/manifest need no change.
- **`scripts/view_sort.py`:** "Scoring method" radio (CPU always; Neural only if `available()`), backbone multiselect + device caption for Neural, generalized per-thumbnail metric caption, method+backbones folded into the scored-list session key.
- **`scripts/ui_common.py`:** `ranked_key(camera, feature, method="cpu")` + `clear_ranked()`.
- **`scripts/view_roi_editor.py`:** purge clears all method variants via `clear_ranked`.
- **NEW `requirements-embedding.txt`** (optional): `torch`, `torchvision` (+ per-machine install notes). Base `requirements.txt` stays torch-free.
- **`README.md`** + **`docs/methodology.md`**: optional neural-scoring section / Path-2 update.

## Verification
- Headless: `embedding.embed` L2-normalized fixed-length; identical→0, different→larger; `score_unsorted(family="nn")` per_metric has resnet keys; **regression** with torch absent → CPU family unchanged. Real data (`pekat-cam3`): cpu vs nn ranking + timing. UI (this AMD laptop → CPU): switch to Neural/ResNet18, device shows `cpu`, captions show resnet distances, no errors. Base-install safety: without the optional requirements, app runs with only the CPU method.
