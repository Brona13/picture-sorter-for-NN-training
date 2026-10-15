---
name: picture-sorter-handover
description: Voice-discussion handover - decisions, rule-based edge-angle tool, embedding-family ideas, TODO list (to be reconciled with current docs)
status: draft
document_type: handoff
last_updated: 2026-10-15
---

# Picture Sorter: Handover

Repo: `Brona13/picture-sorter-for-NN-training` (FastAPI + React). Origin: a Streamlit prototype from summer 2026, since rewritten and expanded.

## 1. What the app is (and is not)

- A **picture/dataset curation tool**. It selects which images matter for training a camera-based vision inspection neural network.
- It does **not** train or test networks. That happens in a separate downstream system. Any quality metrics shown in this app originate from that system.
- Goal: a smaller, smarter dataset instead of brute-force volume, which saves training time and image count.
- Constraints:
  - The camera station uses an older ResNet classifier that outputs one label per fixed ROI crop and has no notion of object position.
  - Development laptop is CPU-only (AMD, no NVIDIA GPU).
  - Work Windows machine has web access to Claude only. Git pushes are done by the user, who has limited git experience and wants step-by-step guidance.
  - Scale: about 20 cameras and about 85 features. Some features are seen by more than one camera.

## 2. Current state / existing pipeline

Camera entity, then image ingestion, then ROI, then dedup/clustering with a 2D scatter (two sliders controlling cluster count), then duplicate filtering, then classification against a golden dataset (novel vs. closest-to-golden), then versioning and export.

- The 2D scatter was benchmarked and optimized. It is now significantly faster.
- The FastAPI + React stack feels much more responsive than Streamlit.
- Earlier planning notes mention Streamlit-native UI elements. Treat those as superseded by the React frontend. Check any such assumptions before reusing them.

## 3. Key decisions (with reasoning)

| Decision | Why |
|---|---|
| Move from fixed manual ROI to **detector-based crops** (hand-label about 5-10 images, auto-cutout across the set) | The fixed-ROI-first approach cost too much manual work. |
| Detector: **pretrained OWL-ViT in image-exemplar mode** | No training is possible (CPU only). The object is hard to describe in words, so exemplars work better than text prompts. Exemplars come from already-ingested images. |
| **Confidence-threshold slider**; low-confidence or undetected images go to a manual bbox-correction view | Avoids trusting all detections blindly. Corrects instead of discarding. The slider style matches the clustering sliders. |
| Golden dataset stays right after detection/correction, before clustering | Only its input changes (detector crops instead of fixed ROI crops). No need to move the step. |
| **Pre-processing filters** (Gaussian, median, bilateral, box, non-local means, morphological, shrink-and-rescale binning) with sliders and live preview; settings saved **per feature** | The camera is low-res color with noise and lighting changes. Same filter is applied to exemplars and searched images. Per-feature because features differ, so neither global nor per-camera fits. |
| **Mask-based object embedding** (mask shape defined once per feature, re-anchored on each image's detected object); background embedding later | Background clutter and lighting pollute OK/NOK judgments. The detector must run before masking. Curation-side only, since production ResNet still sees the full crop. |
| **Pipeline as one sequential flow with a persistent step indicator**, not separate sidebar items | Reflects how ROIs actually move through stages. |
| **ROI overview screen as the home/hub** showing each ROI's pipeline stage; selecting one resumes it | Camera creation is rare, but each ROI/feature runs the pipeline repeatedly and independently, so many ROIs sit at different stages at once. |
| Camera creation + ingestion on one combined, more prominent view | Simpler entry point. |
| Quality values come from the downstream system; this app gets a **form to record them against an exported version** | Traces curation choices to downstream results. First find out what the downstream system can report. |
| App is a **toolbox of selectable methods**: the user picks tools per camera by hand now, a recommendation engine possibly later | Pictures differ per camera, and no single tool fits every situation. |
| Two tool families: **embedding-based** (neural, CPU/GPU) and **rule-based** (hand-specified geometry/pixel rules) | They answer different "what does OK look like" questions. |

## 4. Tool: ROI-scoped scatter (embedding family)

- The user draws their own ROI around a detail they know matters, then runs the scatter/clustering on just that zone.
- This is domain-knowledge-driven. Clustering is pointed at the spot where good vs. bad shows up, and the user then bulk-tags the result as OK / not OK / delete.
- The ROI is a flexible lens redefined per question, not a fixed crop tied to the detector.
- Common use: when clusters are clearly apart, zoom into one, spot a clump of identical bad images, and bulk-delete. This is fast first-pass triage on datasets of a few hundred images.
- Clarified: clustering runs on the full high-dimensional embeddings. The 2D scatter is only a lossy projection for human viewing. The sliders tune the real clustering math.

## 5. Tool: Edge/line angle measurement (rule-based family), concept stage

Use case: the object sits close to the camera against a blurred background, so its edge is high-contrast. Only one specific angle AND direction counts as OK. Any other angle, or the opposite direction, is NOT OK.

**Interaction design (decided):**
1. Click once to place point 1. The line follows the cursor. Click again to place point 2. The line then has position, length and angle.
2. A rectangle auto-generates around the line at a default offset (about 5% of image size).
3. One drag handle on the rectangle's long side resizes the band (no width/height fields).
4. A **live crop preview** sits next to the main image, showing the rectangle's contents.
5. The preview overlays the detector's current line, angle, and the **edge points actually used** (Canny edge pixels or Hough votes) as dots.
6. A **slider sets how many points** feed the fit. For example, start with 5 and raise to 10 if the result is unstable.
7. Stopping criterion: stop adjusting once the overlaid detected line matches what the eye expects.

**Technical notes:**
- Candidate pipeline: Canny, then Hough line transform inside the rectangle. Alternative: least-squares line fit through all edge pixels. Another: `minAreaRect`/contour fit if a mask or bbox already exists.
- Fitting averages across many points, which gives a stable angle instead of a jittery one.
- **Direction comes from pixel gradient polarity** (which side is bright and which is dark), NOT from click order. Decided because it is more robust and the data decides, so how the line was drawn does not matter. Drawing only sets geometry.
- Orientation alone (0-180 degrees) has no direction. The bright/dark side supplies the direction. Pass/fail is then an angle range plus the polarity.

## 6. Embedding-family ideas (backlog)

1. **Outlier / distance-based detection.** Flags images far from everything else, using high-dimensional distance or density (not the 2D plot). It gives an explicit numeric score instead of eyeballing lonely dots. *Marked: worth trying on some cameras.*
2. **Nearest-neighbor retrieval for batch labeling.** Label one image, then pull its closest matches in embedding space to confirm or reject as a batch. It should work on masked embeddings or on user-drawn ROIs. *Marked: useful. A batch feature already exists in the app, but the user is unsure it works or what it is based on. **TODO: inspect it first, then decide whether to fix or build fresh.***
3. **Embedding drift over time.** Detects a camera's images slowly shifting (lighting, lens fouling, mounting). *Parked for later discussion.* Idea: image filenames contain a timestamp, so analysis can be plotted against **time of day** to separate normal daily lighting cycles from real drift, and to relate brightness to time of day.
4. **Near-duplicate detection with a stricter distance threshold** than broad clustering. **TODO: verify whether the existing dedup view already does this properly. Double-check before building anything.**

## 7. Rule-based ideas (user will return to these later)

- Object counting in a region (OK means exactly N).
- Presence/absence in a zone.
- Color/intensity threshold in a region.
- Size/area measurement (blob area within an expected pixel range).

## 8. TODO list

- [ ] Inspect the existing batch functionality (what is it based on, does it work?).
- [ ] Verify whether the dedup view already covers stricter-threshold near-duplicate detection.
- [ ] Prototype the edge-angle tool: two-click line, auto rectangle, drag handle, live crop preview with edge-point dots, point-count slider, gradient-polarity direction.
- [ ] Add outlier detection as an embedding-family tool and test it on a few cameras.
- [ ] Build or fix nearest-neighbor batch labeling (mask or custom ROI).
- [ ] Discuss embedding drift over time, using filename timestamps.
- [ ] Add an augmentation view (X/Y shift, rotation) before export. Derive the shift ranges from measured object movement within the ROI (template matching or feature tracking) instead of guessing.
- [ ] Find out which quality metrics the downstream NN system can report, then add the form that records them against exported versions.
- [ ] Flesh out the feature-vs-camera data model (one feature seen by several cameras).
- [ ] Per-camera ROI progress overview and project-management-style quality tracking, as the hub screen.
- [ ] **Reorganize the UI** into menu tabs, branching, and a logical toolbox structure. Planned after one or two more tools are added, when clutter becomes a problem.
- [ ] Set up git for the Windows project folder (not currently a repo). The user pushes themselves, so give step-by-step guidance.

## 9. Open questions

- Final naming and structure for the toolbox (tabs vs. branching flow).
- Whether a tool recommendation layer is worth building after manual selection works.
- Background embedding design (deferred until object embedding works).
