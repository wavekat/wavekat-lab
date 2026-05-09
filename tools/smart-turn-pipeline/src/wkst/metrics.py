"""Metric helpers — bootstrap CIs + continuation-class recall.

Per ``MISSION.md`` the v1 ship bar is **test F1 with bootstrap 95% CI
lower bound ≥ 0.75** and **continuation-class recall ≥ 0.85**. This
module makes those two numbers a first-class output of every run.

Pure-numpy: no torch dependency, fast enough to compute on every
``wk-st run`` without slowing the pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from sklearn.metrics import f1_score, recall_score


@dataclass(frozen=True)
class BootstrapCI:
    """Result of resampling a metric over labels/preds."""

    point: float
    low: float
    high: float
    n_resamples: int

    def as_dict(self) -> dict:
        return {
            "point": float(self.point),
            "low": float(self.low),
            "high": float(self.high),
            "n_resamples": int(self.n_resamples),
        }


def bootstrap_f1_ci(
    labels: np.ndarray,
    probs: np.ndarray,
    threshold: float,
    *,
    n_resamples: int = 1000,
    confidence: float = 0.95,
    seed: int = 42,
) -> BootstrapCI:
    """Bootstrap (low, high) for F1 on the positive class.

    Resampling is over (label, prob) pairs with replacement. F1 is
    recomputed at the **fixed** input threshold each iteration — we
    do **not** re-pick the operating point per resample, since the
    deployed model uses a fixed threshold and the CI we ship has to
    reflect that.
    """
    labels = np.asarray(labels).astype(int).flatten()
    probs = np.asarray(probs).astype(float).flatten()
    if labels.shape != probs.shape:
        raise ValueError(
            f"labels and probs shape mismatch: {labels.shape} vs {probs.shape}"
        )
    if labels.size == 0:
        return BootstrapCI(point=float("nan"), low=float("nan"),
                           high=float("nan"), n_resamples=0)

    point = float(f1_score(labels, (probs > threshold).astype(int), zero_division=0))

    rng = np.random.default_rng(seed)
    n = labels.size
    samples = np.empty(n_resamples, dtype=float)
    for i in range(n_resamples):
        idx = rng.integers(0, n, n)
        samples[i] = f1_score(
            labels[idx], (probs[idx] > threshold).astype(int),
            zero_division=0,
        )

    alpha = (1.0 - confidence) / 2.0
    low = float(np.quantile(samples, alpha))
    high = float(np.quantile(samples, 1.0 - alpha))
    return BootstrapCI(point=point, low=low, high=high, n_resamples=n_resamples)


def continuation_recall(
    labels: np.ndarray,
    probs: np.ndarray,
    threshold: float,
) -> float:
    """Recall of the **continuation** class (label == 0).

    In the smart-turn schema, ``endpoint_bool=True`` is end-of-turn,
    ``False`` is continuation. The failure mode users hate most per
    ``MISSION.md`` is cutting the speaker off mid-thought — that's a
    miss on the continuation class — so we report this number
    explicitly alongside positive-class F1.
    """
    labels = np.asarray(labels).astype(int).flatten()
    probs = np.asarray(probs).astype(float).flatten()
    preds = (probs > threshold).astype(int)
    if labels.size == 0:
        return float("nan")
    # `pos_label=0` makes recall_score compute TN / (TN + FP).
    return float(recall_score(labels, preds, pos_label=0, zero_division=0))
