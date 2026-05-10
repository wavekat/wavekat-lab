import numpy as np
import pytest

from wkst.metrics import bootstrap_f1_ci, continuation_recall, pr_curve_points


def test_bootstrap_ci_brackets_point_estimate():
    rng = np.random.default_rng(0)
    labels = rng.integers(0, 2, size=200)
    probs = labels.astype(float) * 0.7 + rng.normal(0, 0.2, size=200) + 0.15
    ci = bootstrap_f1_ci(labels, probs, threshold=0.5, n_resamples=200, seed=1)
    assert 0.0 <= ci.low <= ci.point <= ci.high <= 1.0
    assert ci.n_resamples == 200


def test_bootstrap_ci_perfect_classifier():
    labels = np.array([0, 0, 1, 1, 1, 0, 1, 0])
    probs = labels.astype(float) * 0.9 + 0.05
    ci = bootstrap_f1_ci(labels, probs, threshold=0.5, n_resamples=100, seed=2)
    assert ci.point == pytest.approx(1.0)
    assert ci.low > 0.5  # never collapses below random


def test_bootstrap_ci_handles_empty():
    ci = bootstrap_f1_ci(np.array([]), np.array([]), threshold=0.5)
    assert ci.n_resamples == 0
    assert np.isnan(ci.point)


def test_bootstrap_ci_threshold_is_fixed_per_resample():
    """Same threshold every iteration — CI reflects deployment, not val tuning."""
    labels = np.array([0, 1, 1, 0, 1, 0, 1])
    probs = np.array([0.1, 0.9, 0.8, 0.2, 0.7, 0.3, 0.6])
    ci = bootstrap_f1_ci(labels, probs, threshold=0.5, n_resamples=50, seed=3)
    # CI is a band, not a single value
    assert ci.low <= ci.point <= ci.high


def test_bootstrap_ci_shape_mismatch_raises():
    with pytest.raises(ValueError):
        bootstrap_f1_ci(np.zeros(5), np.zeros(6), threshold=0.5)


def test_continuation_recall_perfect_negatives():
    labels = np.array([0, 0, 0, 1, 1])
    probs = np.array([0.1, 0.2, 0.3, 0.9, 0.8])  # never trips on a 0
    assert continuation_recall(labels, probs, threshold=0.5) == 1.0


def test_continuation_recall_all_false_positive():
    labels = np.array([0, 0, 0, 1, 1])
    probs = np.array([0.9, 0.9, 0.9, 0.9, 0.9])  # everything tagged endpoint
    assert continuation_recall(labels, probs, threshold=0.5) == 0.0


def test_continuation_recall_handles_empty():
    import math

    assert math.isnan(continuation_recall(np.array([]), np.array([]), 0.5))


def test_continuation_recall_independent_of_positive_recall():
    """Cont-recall is TN/(TN+FP); flipping all positive labels shouldn't matter."""
    labels = np.array([0, 0, 1, 1])
    probs = np.array([0.1, 0.4, 0.9, 0.95])
    cr_a = continuation_recall(labels, probs, 0.5)

    labels_flipped = np.array([0, 0, 0, 0])  # all neg
    cr_b = continuation_recall(labels_flipped, probs, 0.5)

    # Same negatives correct in case A; in case B, two FPs.
    assert cr_a == 1.0
    assert cr_b == 0.5


def test_pr_curve_points_shape_and_keys():
    rng = np.random.default_rng(0)
    labels = rng.integers(0, 2, size=400)
    probs = labels.astype(float) * 0.6 + rng.normal(0, 0.2, size=400) + 0.2

    pts = pr_curve_points(labels, probs, n_points=50)
    assert 1 <= len(pts) <= 50
    for pt in pts:
        assert set(pt.keys()) == {"t", "p", "r", "f1"}
        assert 0.0 <= pt["p"] <= 1.0
        assert 0.0 <= pt["r"] <= 1.0
        assert 0.0 <= pt["f1"] <= 1.0


def test_pr_curve_points_threshold_monotone():
    """Sub-sampling should preserve threshold ordering — needed for the
    platform UI's slider, which assumes points scan left-to-right in `t`."""
    rng = np.random.default_rng(1)
    labels = rng.integers(0, 2, size=600)
    probs = rng.uniform(0, 1, size=600)
    pts = pr_curve_points(labels, probs, n_points=100)
    ts = [p["t"] for p in pts]
    assert ts == sorted(ts)


def test_pr_curve_points_downsamples_to_target():
    rng = np.random.default_rng(2)
    labels = rng.integers(0, 2, size=2000)
    probs = rng.uniform(0, 1, size=2000)
    pts = pr_curve_points(labels, probs, n_points=200)
    assert len(pts) == 200


def test_pr_curve_points_handles_empty():
    assert pr_curve_points(np.array([]), np.array([])) == []


def test_pr_curve_points_handles_single_class():
    """All labels = 0: precision_recall_curve handles this; we should
    still return something JSON-serialisable rather than crashing."""
    labels = np.zeros(20, dtype=int)
    probs = np.linspace(0.1, 0.9, 20)
    pts = pr_curve_points(labels, probs)
    # Either an empty list (no real positive thresholds) or a tiny one —
    # the contract is "doesn't raise, returns a list of well-formed dicts".
    assert isinstance(pts, list)
    for pt in pts:
        for key in ("t", "p", "r", "f1"):
            assert isinstance(pt[key], float)
