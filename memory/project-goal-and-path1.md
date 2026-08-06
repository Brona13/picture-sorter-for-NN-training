---
name: project-goal-and-path1
session_date: 2026-07-08
last_updated: 2026-07-15
description: Goal is a small, smartly-curated dataset; Path 1 = OpenCV stats, no training
metadata:
  type: project
---

Goal: prepare training data for a camera-based vision-inspection system (classifier vs detector still undecided — doesn't matter yet). Instead of ~500k images, curate a **smaller, diverse** set that avoids redundancy/overtraining, via **novelty/dissimilarity sampling against a golden reference set** (not a trained sorter network).

**Path 1 (current):** pure OpenCV + NumPy — HSV histogram (Bhattacharyya), MSE, and `1−SSIM`; combine, take distance to nearest golden = novelty. No model, no GPU needed.
**Path 2 (fallback, only if Path 1 underperforms):** swap the metrics for pretrained vision embeddings; same pipeline otherwise.

Augmentation (lighting/angles) is explicitly **out of scope** — handled later by the training framework. Hardware: laptop 32 GB RAM, ~4 GB VRAM (CPU is fine for Path 1).
Origin: [[discussions/smart-data-curation]] handover note. See [[data-model-camera-roi-cutout]].
