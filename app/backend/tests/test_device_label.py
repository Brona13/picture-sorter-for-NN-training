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


def test_device_info_names_the_card_and_vendor(patch_torch):
    fake = _fake_torch(hip="6.2", gpu=True)
    fake.cuda.get_device_name = lambda i: "AMD Radeon RX 7800 XT"
    patch_torch(fake)
    assert embedding.device_info() == {"kind": "amd", "label": "AMD GPU", "name": "AMD Radeon RX 7800 XT", "api": "ROCm", "hint": ""}
    fake = _fake_torch(cuda="12.4", gpu=True)
    fake.cuda.get_device_name = lambda i: "NVIDIA GeForce RTX 4070"
    patch_torch(fake)
    info = embedding.device_info()
    assert (info["kind"], info["label"], info["name"], info["api"]) == ("nvidia", "NVIDIA GPU", "NVIDIA GeForce RTX 4070", "CUDA")


def test_device_info_cpu_with_and_without_a_hint(patch_torch, monkeypatch):
    patch_torch(_fake_torch())
    monkeypatch.setattr(embedding.shutil, "which", lambda name: None)
    monkeypatch.setattr(embedding, "_cpu_name", lambda: "Test CPU")
    assert embedding.device_info() == {"kind": "cpu", "label": "CPU", "name": "Test CPU", "api": "", "hint": ""}
    monkeypatch.setattr(embedding.shutil, "which", lambda name: "/x" if name == "nvidia-smi" else None)
    assert "NVIDIA GPU found" in embedding.device_info()["hint"]


def test_device_info_survives_an_unreadable_card_name(patch_torch):
    fake = _fake_torch(cuda="12.4", gpu=True)

    def boom(i):
        raise RuntimeError("no name")

    fake.cuda.get_device_name = boom
    patch_torch(fake)
    assert embedding.device_info()["name"] == ""
