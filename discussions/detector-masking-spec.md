# Picture Sorter: Detector + Masking Update

Design notes from the discussion. Scope: picture sorter app only (curation tool), not the downstream production neural network.

## Problem

- Embeddings are computed on the whole cropped rectangle, so background clutter (e.g. papers) and lighting changes pollute similarity and OK/NOK judgments.
- The object (round, with a screw that leans in various directions) drifts slightly within the crop.
- Production ResNet on the camera station stays unchanged and still sees the whole rectangular crop.

## Core idea

- Split similarity into two embeddings: object-only (inside mask) and background (outside mask).
- Use the object embedding for clustering and OK/NOK selection. Background embedding to be handled later.
- Embedding networks accept any mask shape: blank pixels outside the shape (black or mean value), the image stays rectangular.
- Mask shapes: rectangle, circle, polygon.

## Flow (detector first, masking second)

1. Pick exemplar crops from already ingested images of the feature.
2. Pre-processing filter (same settings for exemplars and query images).
3. Detector finds the object per image (box, confidence).
4. Mask shape is defined once, then re-anchored automatically on each image's detected position.
5. Embeddings (object / background), clustering, dedup, golden dataset, etc. run on masked crops.

## Detector

- Pretrained model, no training: OWL-ViT in image-exemplar mode (Grounding DINO is text-prompt only, a poor fit since the object is hard to describe in words).
- 1 to 3 exemplar crops to start. Vary the crops (lighting, screw lean) rather than adding more of the same kind.
- Model downloaded once from Hugging Face and run locally. Roughly 150 to 600 MB depending on variant.
- Dev currently CPU-only. Later runs on a Windows laptop with an NVIDIA GPU (faster, same code with CUDA PyTorch). Still picture sorter scope, not production inference.
- Low-confidence or missed detections go to manual review (move/adjust box).

## Pre-processing (OpenCV)

- Purpose: reduce color-camera sensor noise and small lighting differences so similarity focuses on structure.
- Applied identically to exemplars and to the images searched.
- Selectable filters:
  - Gaussian blur (default to try first)
  - Median blur (dead pixels, salt-and-pepper noise)
  - Bilateral filter (smooths but keeps edges)
  - Box filter
  - Non-local means denoising (heavier)
  - Morphological open/close
  - Shrink and rescale (binning-like, pyramid down then up)
- Each filter exposes its own parameters via sliders, with a live preview of the effect on the image.
- Settings are saved per feature (not global, not per camera).

## UI: detector page (single page for now, split later if cluttered)

- Exemplar selection from the existing dataset (no separate upload).
- Drawing tools: rectangle, circle, polygon.
- Shapes stay editable after drawing, standard editor behavior: rectangle with 4 corner handles, circle with center and radius handles, polygon with a handle per vertex.
- Candidate count control (dropdown or slider), 1 to 5 boxes per image.
- Confidence threshold slider (0 to 100%): above = trusted, below = manual review.
- Filter selector with parameter sliders and live preview.

## Open items

- Background embedding: how to use it (later).
- Whether segmentation is needed beyond a shape placed on the detected box (for now a circle/polygon on the box is enough).
- Feature vs. camera data model (a feature can be seen by multiple cameras), from earlier notes.

## Workflow notes

- Claude writes the code, Broňa runs and verifies it, Broňa commits and pushes (Claude's GitHub access is read-only).
- Existing stack: FastAPI + React, repo Brona13/picture-sorter-for-NN-training.
