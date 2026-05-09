"""Report tests — ledger → scorecard → README patch."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from wkst import ledger
from wkst.report import (
    END_MARKER,
    START_MARKER,
    ScorecardRow,
    collect_rows,
    rebuild_readme,
    render_scorecard,
)


def _seed_run(repo: Path, *, run: str, **overrides) -> Path:
    dataset, recipe = run.split("/")
    ckpt = repo / "checkpoints" / dataset / recipe
    ckpt.mkdir(parents=True, exist_ok=True)
    payload = {
        "run_name": run,
        "dataset": {
            "n_train": overrides.get("n_train", 1820),
            "n_val": overrides.get("n_val", 228),
            "n_test": overrides.get("n_test", 224),
        },
        "metrics": {
            "val": {"f1": 0.918, "threshold": 0.34},
            "test": overrides.get("test_metrics", {
                "f1": 0.842, "f1_ci95": [0.813, 0.871],
                "continuation_recall": 0.871, "ap": 0.951,
                "n": 224, "threshold": 0.34,
                "source": str(repo / "datasets" / "smart-turn-zh-test-frozen"),
            }),
        },
    }
    results = ckpt / "results.json"
    results.write_text(json.dumps(payload))
    ledger.append(run=run, results_path=results)
    return ckpt


def test_scorecard_row_from_results():
    payload = {
        "run_name": "smart-turn-zh-0503/specaugment",
        "dataset": {"n_train": 100, "n_val": 20, "n_test": 30},
        "metrics": {
            "val": {"f1": 0.9, "threshold": 0.5},
            "test": {
                "f1": 0.8, "f1_ci95": [0.7, 0.9],
                "continuation_recall": 0.85, "ap": 0.92,
                "n": 30, "threshold": 0.5,
                "source": "/abs/datasets/foo",
            },
        },
    }
    row = ScorecardRow.from_results(payload)
    assert row.dataset == "smart-turn-zh-0503"
    assert row.recipe == "specaugment"
    assert row.test_f1_ci == (0.7, 0.9)


def test_collect_rows_orders_by_ledger(fake_repo: Path):
    _seed_run(fake_repo, run="smart-turn-zh-0501/specaugment")
    _seed_run(fake_repo, run="smart-turn-zh-0502/specaugment")
    rows = collect_rows()
    assert [r.run for r in rows] == [
        "smart-turn-zh-0501/specaugment",
        "smart-turn-zh-0502/specaugment",
    ]


def test_collect_rows_dedupes_same_run_keeping_latest(fake_repo: Path):
    _seed_run(
        fake_repo, run="smart-turn-zh-0503/specaugment",
        test_metrics={"f1": 0.70},
    )
    _seed_run(
        fake_repo, run="smart-turn-zh-0503/specaugment",
        test_metrics={"f1": 0.85},
    )
    rows = collect_rows()
    assert len(rows) == 1
    assert rows[0].test_f1 == 0.85


def test_collect_rows_skips_missing_results(fake_repo: Path):
    _seed_run(fake_repo, run="smart-turn-zh-0501/specaugment")
    # ledger entry with broken pointer
    bad = fake_repo / "checkpoints" / "broken" / "r" / "results.json"
    bad.parent.mkdir(parents=True)
    bad.write_text("{}")
    ledger.append(run="broken/r", results_path=bad)
    bad.unlink()

    rows = collect_rows()
    assert all(r.run != "broken/r" for r in rows)


def test_render_scorecard_includes_all_columns(fake_repo: Path):
    _seed_run(fake_repo, run="smart-turn-zh-0503/specaugment")
    table = render_scorecard(collect_rows())
    assert "smart-turn-zh-0503" in table
    assert "specaugment" in table
    assert "0.842" in table
    assert "0.813–0.871" in table
    assert "smart-turn-zh-test-frozen" in table


def test_rebuild_readme_patches_between_markers(fake_repo: Path, tmp_path: Path):
    _seed_run(fake_repo, run="smart-turn-zh-0503/specaugment")

    readme = tmp_path / "README.md"
    readme.write_text(
        "# Title\n\n"
        "Some intro.\n\n"
        f"{START_MARKER}\n\n"
        "OLD TABLE\n\n"
        f"{END_MARKER}\n\n"
        "Footer.\n"
    )
    updated = rebuild_readme(readme)
    assert updated is True
    new_text = readme.read_text()
    assert "OLD TABLE" not in new_text
    assert "smart-turn-zh-0503" in new_text
    assert "Footer." in new_text  # untouched outside markers


def test_rebuild_readme_no_markers_is_noop(
    fake_repo: Path, tmp_path: Path, capsys
):
    readme = tmp_path / "README.md"
    readme.write_text("# README\n\nNo markers here.\n")
    updated = rebuild_readme(readme)
    assert updated is False
    out = capsys.readouterr().out
    assert "no scorecard markers" in out


def test_rebuild_readme_missing_file_raises(fake_repo: Path, tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        rebuild_readme(tmp_path / "nope.md")
