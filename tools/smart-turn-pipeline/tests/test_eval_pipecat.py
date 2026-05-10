"""Tests for ``wk-st eval-pipecat`` — results.json shape + ledger append.

We mock out the heavy bits (``datasets`` loading + ONNX scoring) so
these run without torch / onnxruntime / a real ONNX file.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import numpy as np
import pytest


def _install_fake_datasets(monkeypatch: pytest.MonkeyPatch, n_rows: int) -> None:
    """Stub the bits of ``datasets`` that ``eval_pipecat`` touches."""
    fake = types.ModuleType("datasets")

    class _FakeSplit:
        def __len__(self) -> int:
            return n_rows

        def cast_column(self, *a, **kw):  # noqa: D401, ARG002
            return self

    class _FakeDS(dict):
        def cast_column(self, col, audio):  # noqa: ARG002
            return self

    def _load_dataset(*_, **__):
        return _FakeDS(test=_FakeSplit())

    fake.Audio = lambda **__: None
    fake.disable_progress_bars = lambda: None
    fake.load_dataset = _load_dataset
    monkeypatch.setitem(sys.modules, "datasets", fake)


def _make_smart_turn_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace ``load_smart_turn()`` with a stub exposing a deterministic ``score_onnx``."""
    from wkst import eval_pipecat as ep

    stub = types.SimpleNamespace()

    def score_onnx(onnx_path, fe_source, split, sr, chunk, threshold=0.5):
        n = len(split)
        labels = np.array([0, 1] * (n // 2) + ([0] if n % 2 else []), dtype=int)
        probs = np.linspace(0.1, 0.9, n)
        return {
            "threshold": threshold,
            "probs": probs,
            "labels": labels,
            "accuracy": 0.7,
            "precision": 0.8,
            "recall": 0.6,
            "f1": 0.69,
            "average_precision": 0.75,
            "pr_curve": {"n": 3, "points": [
                {"threshold": 0.25, "precision": 0.5, "recall": 0.9, "f1": 0.64},
                {"threshold": 0.50, "precision": 0.8, "recall": 0.6, "f1": 0.69},
                {"threshold": 0.75, "precision": 0.95, "recall": 0.3, "f1": 0.45},
            ]},
        }

    stub.score_onnx = score_onnx
    monkeypatch.setattr(ep, "load_smart_turn", lambda: stub)


def test_eval_pipecat_writes_results_with_pr_curve(
    fake_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    test_dir = fake_repo / "datasets" / "smart-turn-zh-test-frozen"
    test_dir.mkdir(parents=True)
    (test_dir / "test.parquet").write_bytes(b"not-real-parquet")

    onnx = fake_repo / "fake.onnx"
    onnx.write_bytes(b"not-real-onnx")

    _install_fake_datasets(monkeypatch, n_rows=8)
    _make_smart_turn_stub(monkeypatch)

    from wkst.eval_pipecat import eval_pipecat

    result = eval_pipecat(
        pipecat_onnx=onnx,
        test_dir=test_dir,
        test_export_id="7f862add",
        dataset_name="smart-turn-zh-test-frozen",
        bootstrap_n=50,
    )

    assert result.results_path.exists()
    payload = json.loads(result.results_path.read_text())

    assert payload["run_name"] == "smart-turn-zh-test-frozen/pipecat-v3"
    assert payload["recipe"]["kind"] == "pipecat-onnx"
    assert payload["recipe"]["feature_extractor"] == "openai/whisper-tiny"
    assert payload["test_export_id"] == "7f862add"
    assert payload["metrics"]["val"] is None

    test = payload["metrics"]["test"]
    assert test["n"] == 8
    assert test["threshold"] == 0.5
    assert test["pr_curve"]["n"] == 3
    assert len(test["pr_curve"]["points"]) == 3
    assert "f1_ci95" in test and len(test["f1_ci95"]) == 2


def test_eval_pipecat_appends_to_ledger(
    fake_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    test_dir = fake_repo / "datasets" / "frozen"
    test_dir.mkdir(parents=True)
    (test_dir / "test.parquet").write_bytes(b"x")
    onnx = fake_repo / "x.onnx"
    onnx.write_bytes(b"x")

    _install_fake_datasets(monkeypatch, n_rows=4)
    _make_smart_turn_stub(monkeypatch)

    from wkst import ledger
    from wkst.eval_pipecat import eval_pipecat

    eval_pipecat(
        pipecat_onnx=onnx,
        test_dir=test_dir,
        run_name="pipecat-v3.2-cpu",
        bootstrap_n=20,
    )

    entries = list(ledger.read())
    assert len(entries) == 1
    assert entries[0]["run"] == "frozen/pipecat-v3.2-cpu"
    assert entries[0]["results"].endswith("results.json")


def test_eval_pipecat_missing_test_parquet_errors(
    fake_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty = fake_repo / "datasets" / "empty"
    empty.mkdir(parents=True)
    onnx = fake_repo / "x.onnx"
    onnx.write_bytes(b"x")

    _install_fake_datasets(monkeypatch, n_rows=0)
    _make_smart_turn_stub(monkeypatch)

    from wkst.eval_pipecat import eval_pipecat

    with pytest.raises(FileNotFoundError, match="test.parquet"):
        eval_pipecat(pipecat_onnx=onnx, test_dir=empty)


def test_eval_pipecat_missing_onnx_errors(
    fake_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    test_dir = fake_repo / "datasets" / "frozen"
    test_dir.mkdir(parents=True)
    (test_dir / "test.parquet").write_bytes(b"x")

    _install_fake_datasets(monkeypatch, n_rows=2)
    _make_smart_turn_stub(monkeypatch)

    from wkst.eval_pipecat import eval_pipecat

    with pytest.raises(FileNotFoundError, match="pipecat ONNX"):
        eval_pipecat(
            pipecat_onnx=fake_repo / "does-not-exist.onnx",
            test_dir=test_dir,
        )
