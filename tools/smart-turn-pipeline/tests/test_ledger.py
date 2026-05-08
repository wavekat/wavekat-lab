import json
from pathlib import Path

from wkst import ledger


def test_append_creates_file_and_relativises_path(fake_repo: Path):
    ckpt = fake_repo / "checkpoints" / "smart-turn-zh-0503" / "specaugment"
    ckpt.mkdir(parents=True)
    results = ckpt / "results.json"
    results.write_text("{}")

    ledger.append(
        run="smart-turn-zh-0503/specaugment",
        results_path=results,
    )

    rows = list(ledger.read())
    assert len(rows) == 1
    assert rows[0]["run"] == "smart-turn-zh-0503/specaugment"
    assert rows[0]["results"] == "smart-turn-zh-0503/specaugment/results.json"
    assert "ts" in rows[0]


def test_append_is_append_only(fake_repo: Path):
    results = fake_repo / "checkpoints" / "ds" / "r" / "results.json"
    results.parent.mkdir(parents=True)
    results.write_text("{}")

    for i in range(3):
        ledger.append(run=f"ds/r{i}", results_path=results)

    assert len(list(ledger.read())) == 3


def test_read_missing_ledger_returns_empty(fake_repo: Path):
    assert list(ledger.read()) == []


def test_read_skips_blank_lines(fake_repo: Path):
    path = fake_repo / "checkpoints" / "_ledger.jsonl"
    path.write_text(
        '\n{"ts":"x","run":"a","results":"b"}\n\n'
        '{"ts":"y","run":"c","results":"d"}\n'
    )
    rows = list(ledger.read())
    assert [r["run"] for r in rows] == ["a", "c"]


def test_extra_field_round_trips(fake_repo: Path):
    results = fake_repo / "checkpoints" / "x" / "results.json"
    results.parent.mkdir(parents=True)
    results.write_text("{}")
    ledger.append(
        run="x/r",
        results_path=results,
        extra={"export_id": "abc"},
    )
    rows = list(ledger.read())
    assert rows[0]["extra"] == {"export_id": "abc"}
