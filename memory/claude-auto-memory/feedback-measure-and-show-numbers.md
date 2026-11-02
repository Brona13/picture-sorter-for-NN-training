---
name: feedback-measure-and-show-numbers
description: For speed or quality changes the user wants measured before/after numbers (and a check that results did not get worse) shown before anything is committed
metadata:
  type: feedback
---

When the user asks whether something is slow or whether an idea would help, measure first and show a table: before, each variant, speed-up, and a quality check against the old result (same boxes, found-rate on a planted or known case). They answered "Yes, do items 1-3 and measure first" and "Yes, try both and show me the numbers", and then decided from the table (stop-early yes, a smaller input size only as an option, half precision off).

**Why:** several ideas that sounded good were not (batching added nothing, the GPU overlap step added nothing, half precision changed results), and the honest numbers are what let the user choose. **How to apply:** write a reproducible benchmark (`app/backend/benchmark_detector.py` is the pattern: baseline copy of the old code, variants, quality column), use synthetic or temporary data (never the real `cameras/` or database), say plainly what the test cannot show (real frames), and report the numbers before committing. Related: [[stay-within-project-folder]].
