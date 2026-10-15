# Dedup scatter: projection performance

Measured 2026-10-15 for release 1.14.0. The 2D scatter of the Dedup page projects the clustering
embeddings with UMAP (default) or t-SNE (`app/backend/scatter.py`). This note records what was slow, what
changed and what did not help, so the next change starts from numbers.

Reproduce: `python app/backend/benchmark_scatter.py --sizes 1000 3000 5000 --methods umap tsne`
(needs `umap-learn` and `scikit-learn`; all variants are listed in `scatter.VARIANTS`).

## Setup

- Cloud VM, **2 CPU threads**, Intel Xeon 2.1 GHz, Python 3.13, umap-learn 0.5.12, scikit-learn 1.9.1.
- Synthetic L2-normalised embeddings, 512 dimensions, tight clusters (like near-duplicate frames).
- *warm* = median of repeated calls in one process. *Trustworthiness* (10 neighbours, cosine; 1.0 = the 2D
  layout keeps every neighbourhood) guards against buying speed with a worse picture.
- Noise: the VM is shared; repeated runs vary by roughly ±20 %. Only differences of 1.5× or more are
  treated as real.

## Findings

1. **UMAP below 4096 frames computed exact neighbours with one Python callback per pair.** A profile of a
   3000-frame call showed 9 million `_get_slice` calls (20 s under the profiler, 8 of the 9 s of wall time).
   Above 4096 frames UMAP switches to NN-descent, which is why 5000 frames were *faster* than 3000.
   `force_approximation_algorithm=True` removes the cliff.
2. **Fixed seed means single thread.** `random_state=42` forces UMAP onto one thread. The layout is cached
   per frame set, so reproducibility across recomputations was not worth it.
3. **Layout epochs.** UMAP uses 500 epochs below 10 000 points. 200 gives the same trustworthiness
   (table below) at about half the layout time.
4. **PCA to 50 dimensions** before UMAP lets it use fast euclidean distance on unit vectors (equivalent to
   cosine) instead of cosine on 512–2048 dimensions. Small effect on its own, kept.
5. **First projection of a process: 31 s** (≈9 s importing umap/numba plus ≈20 s JIT compilation). The numba
   cache directory did not help. The kernels are compiled lazily and once per process.
6. **t-SNE: nothing helped.** `n_jobs=-1` and PCA-50 were within noise (table). The Barnes–Hut gradient
   descent dominates and already uses threads. t-SNE stays as it was.

## Results: UMAP, warm seconds (trustworthiness)

| frames | before (1.13) | + NN-descent, PCA-50, threads | + 200 epochs (**now**) |
|-------:|--------------:|------------------------------:|-----------------------:|
|    300 | 0.48 (0.965)  | 0.56 (0.965)                  | 0.37 (0.964)¹          |
|  1 000 | 2.45 (0.990)  | 1.26 (0.990)                  | 0.59 (0.989)           |
|  3 000 | 16.6 (0.998)  | 3.06 (0.998)                  | 1.70 (0.998)           |
|  5 000 | 7.43 (0.975)  | 5.17 (0.975)                  | 2.50 (0.977)           |

¹ Below 500 frames the production code keeps UMAP's default 500 epochs; the figure only shows the effect of
the epoch count on a small set.

## Results: first projection after starting the server (3000 × 512)

| | seconds |
|---|---:|
| no warm-up | 31.4 |
| after `scatter.prewarm()` has finished | 1.7 |

`prewarm()` runs in a background thread the first time the Dedup state is requested (opening the page), so
the import and compilation happen while the user looks at the page or clusters. If "Compute projection" is
pressed before it finishes, it waits for the remainder: never worse than without the warm-up.

## Results: t-SNE, warm seconds (trustworthiness)

| frames | before | PCA-50 + `n_jobs=-1` |
|-------:|-------:|---------------------:|
|  1 000 | 2.45 (0.994) | 3.09 (0.992) |
|  3 000 | 9.65 (0.999) | 10.02 (0.998) |

## Not done, and why

- **GPU.** UMAP and t-SNE in these libraries are CPU code (RAPIDS cuML offers GPU versions but not on
  Windows). With the numbers above the projection is a few seconds for typical sets; the expensive step,
  the embeddings, already runs on the GPU when a CUDA/ROCm PyTorch build is installed. A torch t-SNE would be
  possible but is not justified yet.
- **More threads.** The benchmark VM has 2 threads. NN-descent and the UMAP layout scale with threads, so
  a laptop with 8+ threads should gain more than shown; this has not been measured.
- **Synthetic data.** Real frame embeddings may differ; the speedups come from algorithm paths, not from
  the data, but re-run the benchmark on a real feature before relying on the exact numbers.
