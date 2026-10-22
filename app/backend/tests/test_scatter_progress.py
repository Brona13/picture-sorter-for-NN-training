"""The projection reports how far its layout optimisation is (UMAP epochs, t-SNE iterations)."""
from __future__ import annotations

import numpy as np

import scatter


def test_the_sink_reads_umap_epochs_and_tsne_iterations() -> None:
    seen: list[float] = []
    sink = scatter._ProgressSink("umap", seen.append)
    sink.write("\r50/200")
    sink.write("200/200")
    sink.write("Construct fuzzy simplicial set")  # other text is ignored
    assert seen == [0.25, 1.0]
    seen.clear()
    tsne = scatter._ProgressSink("tsne", seen.append)
    tsne.write("[t-SNE] Iteration 250: error = 70.1, gradient norm = 0.001 (50 iterations in 0.1s)")
    tsne.write("[t-SNE] Computing nearest neighbors...")
    assert seen == [0.25]


def test_a_tsne_projection_reports_a_rising_share_done() -> None:
    rng = np.random.default_rng(0)
    matrix = rng.normal(size=(60, 16)).astype(np.float32)
    seen: list[float] = []
    xy = scatter._tsne(matrix, seen.append)
    assert xy.shape == (60, 2)
    assert seen and seen == sorted(seen) and seen[-1] > 0.9


def test_without_a_callback_nothing_is_printed_or_captured() -> None:
    rng = np.random.default_rng(1)
    xy = scatter._tsne(rng.normal(size=(30, 8)).astype(np.float32))
    assert xy.shape == (30, 2)
