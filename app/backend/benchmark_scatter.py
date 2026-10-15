"""Benchmark the Dedup scatter projection (UMAP / t-SNE) on synthetic embeddings.

    python app/backend/benchmark_scatter.py [--sizes 500 2000 5000] [--dim 512] [--methods umap tsne]

Synthetic data: L2-normalised vectors in tight clusters, like near-duplicate frames.
Each variant is timed (cold = includes first-call import + JIT compilation, warm = median of the following calls) and scored with
trustworthiness (1.0 = the 2D layout keeps every neighbourhood) so a speedup is not bought with quality.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scatter  # noqa: E402


def synthetic(n: int, dim: int, clusters: int | None = None, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    k = clusters or max(5, n // 40)
    centres = rng.normal(size=(k, dim))
    labels = rng.integers(0, k, size=n)
    x = centres[labels] + rng.normal(scale=0.35, size=(n, dim))
    x /= np.linalg.norm(x, axis=1, keepdims=True)
    return x.astype(np.float32)


def trust(matrix: np.ndarray, xy: np.ndarray, sample: int = 1500) -> float:
    from sklearn.manifold import trustworthiness  # noqa: PLC0415

    if len(matrix) > sample:  # trustworthiness is O(n^2): score a fixed random subset of rows
        idx = np.random.default_rng(1).choice(len(matrix), sample, replace=False)
        return float(trustworthiness(matrix[idx], xy[idx], n_neighbors=10, metric="cosine"))
    return float(trustworthiness(matrix, xy, n_neighbors=10, metric="cosine"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sizes", type=int, nargs="+", default=[500, 2000, 5000])
    ap.add_argument("--dim", type=int, default=512)
    ap.add_argument("--methods", nargs="+", default=["umap", "tsne"], choices=["umap", "tsne"])
    ap.add_argument("--repeat", type=int, default=3, help="warm runs per variant (median reported)")
    ap.add_argument("--variants", nargs="+", default=None, help="limit to these variant names")
    args = ap.parse_args()

    print(f"cpu threads: {os.cpu_count()}  dim: {args.dim}")
    print(f"{'method':6} {'n':>6} {'variant':16} {'cold s':>8} {'warm s':>8} {'trust':>6}")
    for method in args.methods:
        for n in args.sizes:
            x = synthetic(n, args.dim)
            for name, fn in scatter.VARIANTS[method].items():
                if args.variants and name not in args.variants:
                    continue
                t0 = time.perf_counter()
                xy = fn(x)
                cold = time.perf_counter() - t0
                warms = []
                for _ in range(args.repeat):
                    t0 = time.perf_counter()
                    xy = fn(x)
                    warms.append(time.perf_counter() - t0)
                warm = float(np.median(warms))
                print(f"{method:6} {n:6} {name:16} {cold:8.2f} {warm:8.2f} {trust(x, xy):6.3f}", flush=True)


if __name__ == "__main__":
    main()
