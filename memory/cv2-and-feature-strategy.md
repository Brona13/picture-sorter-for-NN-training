---
name: cv2-and-feature-strategy
session_date: 2026-07-09
description: How OpenCV (cv2) and learned embeddings map onto the tool's jobs; the diff-heatmap QA idea
last_updated: 2026-07-28
metadata:
  type: project
---

Discussion (2026-07-09) on how to use **cv2 image-manipulation functions** and where a **learned embedding** fits. Extends [[flow-and-roadmap]].

**Framing:** the tool has two jobs — (A) shrink the pile (diversity/de-dup) and (B) catch mislabels (OK/NG QA). Both reduce to: *measure how two images differ, and trust that measurement.* cv2 serves that, organized by stage:

- **Preprocess (trust the comparison):** `resize`, `cvtColor`, `equalizeHist`/`createCLAHE` (lighting normalization), `GaussianBlur`/`fastNlMeansDenoising` (noise).
- **Align (fixes the slight-shift problem that makes MSE weak):** `phaseCorrelation`, `matchTemplate`, `ORB` + `warpAffine`.
- **Measure difference:** `calcHist`/`compareHist`, `Canny`/`Sobel` edges, `HOGDescriptor` (shape), `img_hash` pHash, `ORB` matching.
- **Localize & quantify (QA):** `absdiff` → `threshold` (Otsu/adaptive) → morphology → `findContours`/`contourArea`.
- **Visualize:** `rectangle`/`putText`, and **difference heatmaps**.

**Key idea for the QA ("catch my mistakes") feature:** align a candidate to its nearest golden, `absdiff` → threshold → **overlay a heatmap** so the human sees *where* it differs and verifies in one glance. Embeddings can't easily say *where*; cv2 can.

**Classical cv2 vs learned embedding (the one real decision):**
- cv2 classical = transparent, fast, no model, but hand-crafted / can be brittle.
- ResNet embedding = robust to nuisance variation, learned, but a black box + dependency.
- **Complementary:** use cv2 for the plumbing (align + lighting-normalize + visualize) regardless — it makes embeddings better too. Decide classical-vs-embedding for the actual OK/NG *judgment* based on **how subtle the NG defects are**.
- Encouraging: their setup is a **fixed inspection camera (controlled framing/lighting)** — exactly where classical cv2 methods are strong (they struggle on "wild" photos, not a jig).

**Boundaries:** cv2 *augmentation* (flip/rotate/brightness/warp) is the training framework's job later, **out of scope** here; and cv2 difference is a curation/QA aid, **not** a replacement for the ResNet classifier. Open decision still: [[flow-and-roadmap]] lightweight ResNet embedding.
