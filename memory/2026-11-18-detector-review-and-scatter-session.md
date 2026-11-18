---
name: detector-review-and-scatter-session
description: Session 2026-11-17/18 (Linux) - v1.163.1-v1.164.0 zone cards and step-1 overlay; Windows patches v1.165.0-v1.168.0 applied; detector review views v1.169.0-v1.172.0; Dedup Scatter without muted v1.173.0; all pushed
status: current
document_type: memory
session_date: 2026-11-18
---

# Session 2026-11-17/18 (Linux home workstation): v1.163.1 - v1.173.0

Behaviour now: `docs/current-project.md`. Per-version details and tests: `docs/changelog.md`. Plan: `plans/detector-review-views.md` (source `discussions/detector-review-views-summary.md`).

## Built and pushed
- v1.163.1-v1.164.0: zone cards show dx, dy and distance; pass/fail badges removed (border shows it); aim-icon "Use as nominal"; 📐 switch in a step-2 Classifier viewer draws the step-1 Evaluation geometry (`step_two_measures.py`).
- Measured 5 MP Basler `drone` (~1,000 pictures) with the app log: import 7.6 s, detector ~0.1 s/picture, viewer smooth; no change needed.
- Windows patches v1.165.0-v1.168.0 applied with `git am` (v1.165.1 was missing at first; always check each patch's `-VERSION` against the previous `+VERSION`), files deleted, folder kept.
- Detector review on the detector box page, review only, never stale:
  - v1.169.0 position map per target slot, review zone, live count, click lists pictures, filter All / Not found / Outside.
  - v1.170.0 pair map = Calculate operations + Evaluation charts (user's choice), `review_pair.py`.
  - v1.171.0 "Needs attention first" order + reason on each card (`attention.ts`).
  - v1.172.0 box values: match-score threshold, angle band; box size left out (stored size is the example's).
- v1.173.0 Dedup Scatter maps only unmuted pictures and lays out again; "Include muted" tick (off by default).

## Not clicked through in a browser
All of v1.164.0-v1.173.0; the user ran builds but did not report checks yet.

## Next
- Guided test on `drone`: sort mixed products with a Product Classifier (Chain: Classifier from Ingest, Mode → Product, names), label in bulk on its Scatter islands, then one detector chain per product dot. Waiting on step 1: product names and what is on the drone Chain. The user will do the drawing later.
- Try the detector review on real pictures before deciding on cutout similarity (deferred: overlap view, drift).
- Possible development if the Scatter route is not enough: goldens + Auto-label for a Product-mode Classifier in step 1.
