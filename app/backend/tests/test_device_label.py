"""Device label distinguishes Nvidia CUDA, AMD ROCm and CPU builds of PyTorch."""
from types import SimpleNamespace

import pytest

import embedding


def _fake_torch(hip=None, cuda=None, gpu=False):
    return SimpleNamespace(
        version=SimpleNamespace(hip=hip, cuda=cuda),
        cuda=SimpleNamespace(is_available=lambda: gpu),
    )


@pytest.fixture
def patch_torch(monkeypatch):
    def apply(fake):
        monkeypatch.setattr(embedding, "_torch", fake)
        monkeypatch.setattr(embedding.config, "EMBEDDING_ENABLED", True, raising=False)
        monkeypatch.setattr(embedding.config, "EMBEDDING_DEVICE", "auto", raising=False)
    return apply


def test_rocm_build_is_labelled_amd(patch_torch):
    patch_torch(_fake_torch(hip="6.2", gpu=True))
    assert embedding.torch_backend() == "rocm"
    assert embedding.active_device() == "cuda"
    assert embedding.device_label() == "AMD GPU (ROCm)"


def test_cuda_build_is_labelled_nvidia(patch_torch):
    patch_torch(_fake_torch(cuda="12.4", gpu=True))
    assert embedding.torch_backend() == "cuda"
    assert embedding.device_label() == "Nvidia GPU (CUDA)"


def test_cpu_build_hints_when_gpu_tooling_present(patch_torch, monkeypatch):
    patch_torch(_fake_torch())
    monkeypatch.setattr(embedding.shutil, "which", lambda name: "/x" if name == "rocminfo" else None)
    assert embedding.torch_backend() == "cpu"
    assert "AMD GPU found" in embedding.device_label()


def test_plain_cpu_label(patch_torch, monkeypatch):
    patch_torch(_fake_torch())
    monkeypatch.setattr(embedding.shutil, "which", lambda name: None)
    assert embedding.device_label() == "cpu"
