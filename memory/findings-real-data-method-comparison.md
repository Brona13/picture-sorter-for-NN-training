---
name: findings-real-data-method-comparison
session_date: 2026-07-16
last_updated: 2026-07-28
description: Real-data comparison of CPU vs ResNet scoring on pekat-cam3 — SSIM dominates, MSE is inert, frames are near-duplicates
metadata:
  type: project
---

Measured on the real `pekat-cam3` ROI **suspension-rod-front-left**, 39 unsorted frames (2026-07-16). Contact sheet: `cameras/pekat-cam3/logs/method_comparison.png`.

**1. The batch is highly redundant.** ResNet cosine distances span only **0.015–0.038** (resnet18) — in embedding space these cutouts are essentially the *same image*. Practical read: this batch adds little diversity for that ROI; a handful of representatives is enough.

**2. SSIM alone effectively *is* the CPU ranking.** Per-metric on the CPU top picks: `ssim ≈ 0.30–0.37` but `hist ≈ 0.01–0.04` and `mse ≈ 0.01–0.03` — SSIM is ~10× the others, so with equal weights it dominates the average. **The three classical metrics are not on
comparable effective scales**, so equal weights ≠ equal influence. If balanced contribution is wanted, normalise per-metric scale (or compensate via weights).

**3. MSE is inert here, not harmful.** Setting `METRIC_WEIGHTS["mse"]=0` leaves the ranking essentially identical (Spearman **+0.999**, top-10 overlap **10/10**) — it only shifts the absolute numbers up. This *corrects* the earlier assumption that MSE was distorting results because of the slight frame shift: its values are simply too small to sway the average.

**4. The two families give a genuinely different second opinion.** CPU vs resnet18 Spearman **+0.495**, top-10 overlap **4/10** (unchanged whether MSE is on or off, so the disagreement is real, not an MSE artifact). resnet18 vs resnet50: rho +0.468.

**5. All three methods agree on the single most-novel frame** (`…033749`) — the one with a visibly shifted rod / more dark area. Consensus at the top is a good sanity signal.

Timing (39 frames, CPU device): cpu ≈ 3.6 s, resnet18 ≈ 8.2 s, resnet50 ≈ 5.9 s.

**Two-sided follow-up (2026-07-27), same ROI with real goldens (2 ⭐OK / 3 ⭐NG):** margins between the OK and NG sides are **tiny (~0.000–0.011)** — every candidate sits almost exactly between the two reference sets, which re-confirms the near-duplicate nature in the *two-sided* (Classify) setting, not just the one-sided novelty ranking above. Practical consequences:
- **"Most uncertain first"** ordering (smallest margin) + the **"Methods disagree"** filter are the highest-value review levers here — they surface the genuinely ambiguous frames.
- More goldens **per class** sharpen the margins; 2–3 references on near-identical images give inherently low-confidence leanings.

See [[cv2-and-feature-strategy]] and [[flow-and-roadmap]].
