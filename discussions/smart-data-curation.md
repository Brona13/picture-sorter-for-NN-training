---
name: smart-data-curation
description: Early methodology discussion for curating a smaller, diverse vision-training dataset
status: historical
document_type: handoff
last_updated: 2026-07-08
---

# Handover: Smart Training Data Curation for Vision Inspection System

## Context / Goal

Preparing for an upcoming project: a camera-based vision inspection system (classifier or detector — not yet decided, doesn't matter for this part) that needs to recognize products, quality, and presence. Typical guidance suggests large datasets (e.g. ~500,000 images), but the goal is to explore whether a **smaller, smartly curated dataset** can achieve similar training quality — saving time and avoiding overtraining.

This is still in the **planning / helicopter-view stage** — no project has landed yet, no code written. The aim is to have a clear methodology ready before real data arrives.

## Key Decisions So Far

- **Augmentation (lighting, angles, etc.) is out of scope for this discussion.** That's handled automatically/semi-automatically later via toggles in the training framework once base images are selected. Not something to build now.
- **Chosen approach: diversity/dissimilarity sampling against a "golden dataset"** — not training a separate sorter network.
  - Rejected alternative: training a small side classifier ("okay" vs "not okay" picture sorter) to flag uncertain/valuable images. Valid method, but more complex and resource-intensive than needed right now.
  - Preferred approach was inspired by face-recognition-style comparison tools (compare new image against stored references, get a similarity/probability score).
- **Two possible technical paths identified:**
  1. **Path 1 (chosen starting point):** No model, no training. Pure statistical/pixel-based image comparison (histograms, pixel differences, structural similarity) using **OpenCV + NumPy** (optionally scikit-image for structural similarity metrics). Lightweight, fast, no GPU needed.
  2. **Path 2 (future option if Path 1 underperforms):** Use a pretrained embedding model (e.g. via Hugging Face or sentence-transformers-style vision embeddings) to get feature vectors, then measure distance between embeddings. More robust, still no training required (uses existing pretrained weights only).
- **Decision: start with Path 1**, evaluate results, escalate to Path 2 only if needed.

## Hardware Check

- Laptop: 32 GB RAM, NVIDIA GPU with ~4 GB VRAM.
- Confirmed sufficient for Path 1 (CPU-only work) and would also be sufficient for Path 2 or lightweight training later.
- OpenCV *can* be GPU-accelerated via CUDA but this is unnecessary for this task — CPU is fine.

## Planned Folder Structure

```
project-root/
├── docs/                  (documentation)
├── golden-dataset/        (reference "perfect" sample images)
├── unsorted/              (inbox — new images to be evaluated)
├── selected/              (images chosen as most valuable/different)
├── rejected/              (images not selected)
└── logs/                  (tracking what's been processed — avoid reprocessing on reruns)
```

- Logging first; a database is a possible future evolution but considered overkill for now.

## Planned Tooling

- **Backend:** Python, OpenCV + NumPy (Path 1 comparison logic: histogram comparison, MSE, structural similarity).
- **Frontend/GUI:** Streamlit — with a progress bar showing processing status (e.g. "300 of 1000 images processed"), and ideally displaying similarity scores / thumbnails of top-ranked (most dissimilar) candidates.

## Next Steps (not yet started)

1. Build basic folder structure.
2. Write Python script: load golden dataset, loop through unsorted images, compute dissimilarity score (start with histogram comparison / MSE), rank results.
3. Add logging so re-runs don't duplicate work.
4. Wrap in a Streamlit UI with a progress bar.
5. Evaluate whether Path 1 results are good enough; consider Path 2 (pretrained embeddings) if not.
6. Once curation approach is validated, proceed to actual model training/selection question (classifier vs. detector) — deferred until this stage is solid.

## Notes on Working Style

- Prefers building theoretical/methodological understanding before touching code.
- Wants to iterate and track progress carefully (logs, later possibly a database).
- Comfortable with Python but relatively new to this specific ML/vision-data-curation topic — appreciates concepts broken into basic terms first, with option to go deeper.
