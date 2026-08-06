---
name: image-sorting-tool-handoff
description: Design handoff for the image-sorting and training-data-curation tool
status: current
document_type: handoff
last_updated: 2026-07-29
---

# Image Sorting Tool — Design Handoff

**Purpose**: Preprocessing tool (Python, Streamlit prototype) for curating image datasets before neural network training. Goal: feed the network a small, high-value, diverse subset instead of tens of thousands of raw images.

**Context**: Fixed-camera setup (4 views), ROI-based analysis (rectangle drawn on reference image, ROI named e.g. "screw", "connector"). Currently hundreds of images per camera for testing.

---

## Problem Framing

Not a sorting-by-camera or classification problem primarily — it's a **dataset curation** problem. Aim: minimize retraining cost by avoiding redundant/near-duplicate images while maximizing diversity within each class (okay / not good).

---

## Existing Architecture (already built)

- OpenCV + ResNet18/50 for embeddings
- Folder-per-camera structure on disk; `unsorted/` folder for ingest
- SQLite database for metadata — **images never move on disk** until final export
- Golden set concept: manually pick reference "okay" and "not good" examples per ROI
- Candidates scored against golden via embedding distance → results shown in a grid → manual confirm/correct
- Versioning button: freezes current state with a version number/comment into DB
- **Deferred**: final export step (copying frozen dataset from `unsorted/` into class/state folders) — explicitly not being worked on yet, considered straightforward

---

## Key Design Decisions from This Session

### 1. Dedup approach — changed from threshold to clustering

**Dropped**: pairwise similarity histogram + two-handle slider (duplicate / review-zone / unique split). This was designed for the old golden-dependent, per-class threshold approach.

**Adopted**: **DBSCAN clustering** on raw candidate embeddings.
- Key benefit: **works independently of golden set** — no need to know class before deduping. This resolves the ordering problem (previously: dedup thresholds were meant to be per-class, but class doesn't exist until golden scoring runs — DBSCAN sidesteps this entirely).
- Parameters exposed as **sliders**:
  - `epsilon` — neighborhood radius (main tuning parameter)
  - `minPoints` — minimum images to form a cluster (small integer, e.g. 2–5)
- Live feedback while adjusting sliders: cluster count, e.g. "12 clusters covering 340 images, 60 unique"
- One representative kept per cluster; rest dropped (or flagged, not deleted)
  - Default representative selection: **centroid proximity** (closest to cluster average embedding)
  - Manual override: click any thumbnail in a cluster to choose the keeper
  - Alternative representative strategies noted for later: quality-based, golden-proximity-based
- Anything not grouped into a cluster = automatically unique, no threshold decision needed

### 2. Visualization — 2D scatter plot

- **UMAP or t-SNE** to flatten embeddings to 2D for visual sanity-checking of clusters
- Color-coded by cluster; representative marked distinctly (outline/larger marker)
- **Important caveat**: 2D projection distorts real distances — use only for visual sanity check, never for final numeric threshold/cluster decisions (those happen in full-dimensional space)
- Interactive: hover/click a dot to see thumbnail

### 3. Comparison tool

- **Any two points** selectable (click + modifier key), regardless of cluster — no fixed "cross-cluster" vs "within-cluster" mode. User decides what comparison is meaningful.
- Selected pair renders as side-by-side thumbnails
- **Flicker/blink comparator** (toggle mode): classic technique (blink comparator, historically used in astronomy) for spotting subtle differences
  - Interval slider (e.g. 0.1 sec)
  - Press-and-hold button to flicker between the two images; release freezes on current image
  - Requires both images cropped to same ROI dimensions/alignment to be effective
  - **Implementation plan**: build first as Streamlit `@st.fragment` (isolates rerun to just this widget, avoiding full-page reruns on each flicker tick) — test if 0.1s timing feels acceptable. If janky, fall back to a custom JS/HTML component for smoother timing. **Streamlit first, JavaScript later.**

### 4. Golden set workflow — iterative, not one-shot

- Start with ~3 golden images per class (okay / not good)
- Recalculate → check separation via **indicator bars** (confidence/leaning per class)
- If bars are tight (poor separation) → add more goldens
- **Uncertainty sampling**: rather than browsing randomly for new golden candidates, surface candidates closest to the decision boundary (most ambiguous) — these sharpen class separation the most when labeled
  - Best practice pairs uncertainty with **diversity** — avoid shortlisting several near-identical ambiguous images; spread across different "flavors" of ambiguity (not yet implemented/decided in detail)
- Repeat cycle until bars show clean separation

### 5. Overall flow sequencing (resolved)

1. Set camera (folder), set ROI (rectangle) on reference image
2. **Run DBSCAN dedup on raw candidate pool** — golden-independent, thins the pool early
3. Pick small initial golden set (okay + not good)
4. Score deduped/unique candidates against golden → provisional class per candidate
5. Use **uncertainty sampling** to guide golden refinement — iterate: refine golden → re-score → check separation bars → repeat
6. This golden ↔ dedup loop is **not strictly sequential** — can revisit dedup after golden improves, or refine golden further after a dedup pass thins the pool. Exit the loop whenever satisfied.
7. Manual final labeling/confirmation in grid
8. Version/freeze (button — already implemented)
9. Export to designated class/state folders (**deferred**, not yet built)

---

## Open Items / Deferred for Later

- Per-class dedup strictness (tight threshold for okay, loose/off for not good) was a goal under the old threshold method — **doesn't map cleanly onto DBSCAN** (DBSCAN has no class concept). Not yet reconciled — possible option: run DBSCAN separately per provisional class pile after golden scoring, if class-specific dedup strictness is still wanted.
- Final export step (copy frozen dataset to class/state folders) — explicitly not designed yet.
- Not-good image scarcity (real defects are rare/costly in production) — known constraint; industry-standard mitigation is synthetic augmentation/defect simulation. Already familiar to user, not elaborated further.
- Diversity sampling alongside uncertainty sampling — mentioned as best practice, not yet designed in detail.

---

## Industry Context (for reference, not invented locally)

- Overall pattern matches **active learning / coreset selection** as used in industrial vision inspection (defect detection).
- Golden set ≈ "anchor set" / "reference set" in active learning literature.
- Ambiguous-candidate-first review ≈ **uncertainty sampling**, a standard active learning strategy.
- Dedup-by-clustering (DBSCAN/hierarchical) is standard practice at scale, vs. naive pairwise comparison which becomes computationally heavy only once volume reaches tens of thousands of images (not a concern yet at current hundreds-per-camera volume).
