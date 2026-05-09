"""W&B integration — viewer, not source of truth.

Per the design doc, ``WANDB_API_KEY`` set ⇒ log to W&B; unset ⇒
everything still works, just no cloud dashboard. Every wkst run
writes the same artifacts either way; W&B never sees a metric the
local ``results.json`` doesn't already carry.

Two responsibilities here:
1. ``init_run(...)`` — start a wandb run if available, return the
   handle (or None). Idempotent enough to be called from both
   ``HF Trainer`` (via ``report_to="wandb"``) and our post-train
   eval block.
2. ``log_test_metrics(run, metrics)`` — push the test-time block
   that HF Trainer never sees: bootstrap CIs, cont-recall, the test
   source, etc.
"""

from __future__ import annotations

import os
from typing import Any


def is_enabled() -> bool:
    """Cheap predicate — was a W&B API key configured?"""
    return bool(os.environ.get("WANDB_API_KEY"))


def init_run(
    *,
    project: str,
    run_name: str,
    config: dict | None = None,
    tags: list[str] | None = None,
) -> Any | None:
    """Start a wandb run if W&B is configured; otherwise return None.

    We swallow import errors so a partial install (no `wandb` package)
    behaves like "tracking disabled" rather than crashing the train
    loop.
    """
    if not is_enabled():
        return None
    try:
        import wandb  # noqa: WPS433
    except ImportError:
        return None
    if wandb.run is not None:
        # HF Trainer already started a run — reuse it. Tags get merged.
        if tags:
            wandb.run.tags = list(set((wandb.run.tags or ()) + tuple(tags)))
        return wandb.run
    return wandb.init(project=project, name=run_name, config=config or {}, tags=tags)


def log_test_metrics(run: Any | None, metrics: dict) -> None:
    """Log a flat dict of test-time metrics under a `test/*` namespace.

    No-op if ``run`` is None (tracking disabled). Numeric scalars are
    logged via ``run.log``; lists / nested dicts go to ``run.summary``
    so they're visible on the run page without polluting the timeseries.
    """
    if run is None:
        return
    flat: dict[str, float] = {}
    summary: dict[str, Any] = {}
    for key, value in metrics.items():
        prefixed = f"test/{key}"
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            flat[prefixed] = float(value)
        else:
            summary[prefixed] = value
    if flat:
        run.log(flat)
    if summary:
        for k, v in summary.items():
            run.summary[k] = v


def finish(run: Any | None) -> None:
    if run is None:
        return
    try:
        run.finish()
    except Exception:  # noqa: BLE001 — W&B finish should never break the CLI
        pass
