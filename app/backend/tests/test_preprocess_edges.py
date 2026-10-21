"""The edge and contrast filters: every filter keeps shape and dtype; edge filters light up a step edge."""
import cv2
import numpy as np
import pytest

import preprocess

NEW = ["unsharp", "edge_enhance", "sobel", "canny", "laplacian", "morph_gradient", "clahe"]


def step_picture(color=True):
    img = np.full((40, 40), 60, np.uint8)
    img[:, 20:] = 200  # vertical step edge between columns 19 and 20
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR) if color else img


@pytest.mark.parametrize("name", list(preprocess.FILTERS))
@pytest.mark.parametrize("color", [True, False])
def test_every_filter_keeps_shape_and_dtype(name, color):
    img = step_picture(color)
    out = preprocess.apply(img, name)
    assert out.shape == img.shape and out.dtype == np.uint8


@pytest.mark.parametrize("name", ["sobel", "canny", "laplacian", "morph_gradient"])
def test_edge_maps_are_bright_on_the_edge_and_dark_on_flat_areas(name):
    out = preprocess.apply(step_picture(), name, {"low": 50, "high": 100} if name == "canny" else None)
    g = out[..., 0]
    assert g[:, 18:22].max() > 100
    assert g[:, :10].max() == 0 and g[:, 30:].max() == 0


@pytest.mark.parametrize("name", ["unsharp", "edge_enhance"])
def test_sharpening_overshoots_at_the_edge_and_leaves_flat_areas(name):
    out = preprocess.apply(step_picture(), name)
    assert out[20, 20, 0] > 200 or out[20, 19, 0] < 60  # the edge gets steeper
    assert (out[:, :8] == 60).all() and (out[:, 32:] == 200).all()


def test_clahe_raises_contrast_of_a_dull_picture():
    rng = np.random.default_rng(0)
    img = (100 + rng.integers(0, 20, (64, 64, 3))).astype(np.uint8)
    assert preprocess.apply(img, "clahe").std() > img.std()


def test_canny_thresholds_in_either_order_give_the_same_result():
    img = step_picture()
    a = preprocess.apply(img, "canny", {"low": 40, "high": 120})
    b = preprocess.apply(img, "canny", {"low": 120, "high": 40})
    assert (a == b).all()


def test_new_filters_validate_their_parameters():
    for name in NEW:
        assert preprocess.normalize(name, None) == preprocess.default_params(name)
    with pytest.raises(preprocess.FilterError):
        preprocess.normalize("sobel", {"gain": 99})
