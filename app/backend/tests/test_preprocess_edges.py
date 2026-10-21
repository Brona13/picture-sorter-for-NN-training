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


# --- grey, black and white, blobs, outline --------------------------------------------------------
def two_blobs(dark=False):
    img = np.zeros((100, 200), np.uint8)
    cv2.ellipse(img, (50, 50), (30, 15), 20, 0, 360, 255, -1)  # big
    cv2.ellipse(img, (150, 50), (25, 12), -30, 0, 360, 255, -1)  # big
    cv2.circle(img, (100, 10), 3, 255, -1)  # speck
    img = 255 - img if dark else img
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def test_grey_makes_three_equal_channels_of_a_colour_picture():
    img = np.dstack([np.full((8, 8), v, np.uint8) for v in (10, 100, 200)])
    out = preprocess.apply(img, "grey")
    assert out.shape == img.shape and (out[..., 0] == out[..., 1]).all() and (out[..., 1] == out[..., 2]).all()


@pytest.mark.parametrize("mode", ["otsu", "fixed", "adaptive"])
def test_threshold_gives_pure_black_and_white_with_objects_white(mode):
    for dark in (False, True):
        out = preprocess.apply(two_blobs(dark), "threshold", {"mode": mode, "objects": "dark" if dark else "bright"})
        assert set(np.unique(out)) <= {0, 255}
        assert out[50, 50, 0] == 255 and out[2, 2, 0] == 0 if mode != "adaptive" else out[50, 50, 0] in (0, 255)


def test_blobs_keeps_the_biggest_ones_above_the_smallest_size():
    img = two_blobs()
    out = preprocess.apply(img, "blobs", {"count": 2, "min_size": 2.0})
    n = cv2.connectedComponents((out[..., 0] > 0).astype(np.uint8))[0] - 1
    assert n == 2 and out[10, 100, 0] == 0  # the speck is gone
    assert cv2.connectedComponents((preprocess.apply(img, "blobs", {"count": 1, "min_size": 2.0})[..., 0] > 0).astype(np.uint8))[0] - 1 == 1
    assert preprocess.apply(img, "blobs", {"count": 2, "min_size": 30.0}).max() == 0  # nothing that big


def test_outline_draws_contours_and_ellipses_white_on_black():
    blobs = preprocess.apply(two_blobs(), "blobs", {"count": 2, "min_size": 2.0})
    area = lambda m: int((preprocess.apply(blobs, "outline", {"mode": m})[..., 0] > 0).sum())  # noqa: E731
    assert 0 < area("contour") < area("ellipse_filled")
    assert preprocess.apply(blobs, "outline", {"mode": "ellipse_filled"})[50, 50, 0] == 255
    assert preprocess.apply(blobs, "outline", {"mode": "contour"})[50, 50, 0] == 0  # hollow


def test_choice_parameters_are_validated():
    with pytest.raises(preprocess.FilterError):
        preprocess.normalize("threshold", {"mode": "nope"})
    with pytest.raises(preprocess.FilterError):
        preprocess.normalize("threshold", {"level": "128"})
    assert preprocess.normalize("outline", None) == {"mode": "contour", "thickness": 2}


def test_sobel_direction_picks_vertical_or_horizontal_edges():
    img = step_picture()  # one vertical edge
    vertical = preprocess.apply(img, "sobel", {"direction": "x"})
    horizontal = preprocess.apply(img, "sobel", {"direction": "y"})
    assert vertical.max() > 100 and horizontal.max() == 0
