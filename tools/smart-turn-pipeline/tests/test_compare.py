"""Compare tests — read mode + table rendering. Cross-eval needs torch."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from wkst.compare import (
    load_run_cards,
    render_cross_eval_table,
    render_read_table,
)


def _write_results(ckpt: Path, *, run_name: str, test_metrics: dict | None) -> None:
    ckpt.mkdir(parents=True, exist_ok=True)
    payload = {
        "run_name": run_name,
        "metrics": {"val": {"f1": 0.9}, "test": test_metrics},
    }
    (ckpt / "results.json").write_text(json.dumps(payload))


def test_load_run_cards_reads_each_results(fake_repo: Path):
    a = fake_repo / "checkpoints" / "ds-0501" / "specaugment"
    b = fake_repo / "checkpoints" / "ds-0502" / "specaugment"
    _write_results(a, run_name="ds-0501/specaugment", test_metrics={"f1": 0.9})
    _write_results(b, run_name="ds-0502/specaugment", test_metrics={"f1": 0.85})

    cards = load_run_cards([a, b])
    assert [c.label for c in cards] == [
        "ds-0501/specaugment", "ds-0502/specaugment",
    ]
    assert cards[0].results["metrics"]["test"]["f1"] == 0.9


def test_load_run_cards_missing_results_raises(fake_repo: Path):
    empty = fake_repo / "checkpoints" / "ds" / "noruns"
    empty.mkdir(parents=True)
    with pytest.raises(FileNotFoundError, match="results.json"):
        load_run_cards([empty])


def test_render_read_table_handles_missing_metrics(fake_repo: Path):
    ckpt = fake_repo / "checkpoints" / "ds" / "r"
    _write_results(ckpt, run_name="ds/r", test_metrics=None)
    table = render_read_table(load_run_cards([ckpt]))
    assert "ds/r" in table
    assert "—" in table  # placeholder for missing values


def test_render_read_table_formats_ci(fake_repo: Path):
    ckpt = fake_repo / "checkpoints" / "ds" / "r"
    _write_results(ckpt, run_name="ds/r", test_metrics={
        "f1": 0.842, "f1_ci95": [0.81, 0.87], "ap": 0.95,
        "n": 224, "threshold": 0.34, "continuation_recall": 0.871,
        "source": "/some/abs/path/datasets/smart-turn-zh-test-frozen",
    })
    table = render_read_table(load_run_cards([ckpt]))
    assert "0.842" in table
    assert "0.810–0.870" in table
    assert "0.871" in table
    assert "smart-turn-zh-test-frozen" in table  # path shortened to leaf


def test_render_cross_eval_table_grid_shape():
    grid = {
        "runs": ["A", "B"],
        "tests": ["t0", "t1"],
        "rows": [
            {"run": "A", "test": "t0", "f1": 0.80},
            {"run": "A", "test": "t1", "f1": 0.70},
            {"run": "B", "test": "t0", "f1": 0.85},
            # B × t1 deliberately missing — table should render '—'
        ],
    }
    table = render_cross_eval_table(grid, metric="f1")
    assert "| A | 0.800 | 0.700 |" in table
    assert "| B | 0.850 | — |" in table


def test_render_cross_eval_table_metric_switch():
    grid = {
        "runs": ["A"], "tests": ["t0"],
        "rows": [{"run": "A", "test": "t0", "f1": 0.8, "ap": 0.95}],
    }
    f1_table = render_cross_eval_table(grid, metric="f1")
    ap_table = render_cross_eval_table(grid, metric="ap")
    assert "0.800" in f1_table
    assert "0.950" in ap_table
