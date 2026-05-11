"""Unit tests for :mod:`wkst.publish`.

Cover staging (no network) and the model-card language section render.
The actual ``upload`` codepath is not exercised — it requires HF_TOKEN
and would push to a real repo. Trust ``huggingface_hub`` to do its job;
verify only that we hand it the right files.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from wkst import publish


def _make_fake_checkpoint(tmp_path: Path) -> Path:
    """Build a checkpoint dir with a stub ONNX file and a results.json."""
    ckpt = tmp_path / "fake-run"
    (ckpt / "onnx").mkdir(parents=True)
    onnx = ckpt / "onnx" / "smart-turn-int8.onnx"
    onnx.write_bytes(b"\x00ONNX-STUB\x00" * 16)

    results = {
        "run_name": "fake-run",
        "ts": "2026-05-11T00:00:00+00:00",
        "dataset": {"n_train": 100, "n_val": 10, "n_test": 20, "export_id": "abc"},
        "recipe": {"name": "baseline", "kind": "smart-turn-finetune", "threshold": 0.5},
        "metrics": {
            "test": {
                "threshold": 0.5,
                "f1": 0.821,
                "precision": 0.8,
                "recall": 0.85,
                "accuracy": 0.83,
                "ap": 0.9,
                "n": 20,
                "pr_curve": {"n": 100, "drop": "this should not be in published json"},
            },
        },
        "export": {
            "int8": {
                "path": "/abs/path/that/should/be/dropped.onnx",
                "size_mb": 7.8,
                "metrics": {"f1": 0.815, "n": 20, "pr_curve": "drop"},
                "bench": {"p50_ms": 12.0, "p95_ms": 15.5},
            },
            "drift": {"f1": -0.006},
        },
    }
    (ckpt / "results.json").write_text(json.dumps(results))
    return ckpt


def test_stage_run_writes_expected_layout(tmp_path: Path) -> None:
    ckpt = _make_fake_checkpoint(tmp_path)
    staging = tmp_path / "stage"

    plan = publish.stage_run(
        checkpoint_dir=ckpt,
        lang="zh",
        staging_dir=staging,
    )

    assert plan.onnx_dest == staging / "zh" / "smart-turn-cpu.onnx"
    assert plan.onnx_dest.is_file()
    assert plan.onnx_dest.read_bytes().startswith(b"\x00ONNX-STUB")

    slim = json.loads(plan.results_dest.read_text())
    assert slim["lang"] == "zh"
    assert slim["metrics"]["test"]["f1"] == pytest.approx(0.821)
    # pr_curve must be dropped — it's huge and not useful in a public mirror.
    assert "pr_curve" not in slim["metrics"]["test"]
    # absolute filesystem paths must not leak into the published json.
    assert "path" not in slim["export"]["int8"]

    assert plan.model_card_dest.read_text().lstrip().startswith("---")
    assert plan.gitattributes_dest.read_text().startswith("*.onnx filter=lfs")


def test_stage_run_accepts_onnx_override(tmp_path: Path) -> None:
    """When no INT8 ONNX exists in the checkpoint, --onnx must work."""
    ckpt = tmp_path / "empty-run"
    ckpt.mkdir()

    external = tmp_path / "upstream.onnx"
    external.write_bytes(b"upstream pipecat bytes")

    plan = publish.stage_run(
        checkpoint_dir=ckpt,
        lang="zh",
        staging_dir=tmp_path / "stage",
        onnx_override=external,
    )

    assert plan.onnx_dest.read_bytes() == b"upstream pipecat bytes"
    # results.json is still written, with a placeholder note.
    slim = json.loads(plan.results_dest.read_text())
    assert slim["lang"] == "zh"
    assert "note" in slim


def test_model_card_lists_published_languages(tmp_path: Path) -> None:
    ckpt = _make_fake_checkpoint(tmp_path)
    staging = tmp_path / "stage"

    # First publish: zh only.
    publish.stage_run(checkpoint_dir=ckpt, lang="zh", staging_dir=staging)
    card = (staging / "README.md").read_text()
    assert "| `zh` | `zh/smart-turn-cpu.onnx` | test F1 = 0.821 |" in card
    assert "| `ja`" not in card

    # Second publish into the same staging dir: ja gets added to the card.
    publish.stage_run(checkpoint_dir=ckpt, lang="ja", staging_dir=staging)
    card = (staging / "README.md").read_text()
    assert "| `zh` |" in card
    assert "| `ja` |" in card


def test_stage_run_rejects_invalid_lang(tmp_path: Path) -> None:
    ckpt = _make_fake_checkpoint(tmp_path)
    staging = tmp_path / "stage"
    with pytest.raises(ValueError):
        publish.stage_run(checkpoint_dir=ckpt, lang="zh/../etc", staging_dir=staging)
    with pytest.raises(ValueError):
        publish.stage_run(checkpoint_dir=ckpt, lang="", staging_dir=staging)


def test_stage_run_errors_when_no_onnx(tmp_path: Path) -> None:
    ckpt = tmp_path / "no-export"
    ckpt.mkdir()
    with pytest.raises(FileNotFoundError):
        publish.stage_run(
            checkpoint_dir=ckpt,
            lang="zh",
            staging_dir=tmp_path / "stage",
        )


def test_dry_run_does_not_call_huggingface(monkeypatch, tmp_path: Path) -> None:
    """publish_run(dry_run=True) must not import huggingface_hub."""

    def boom(*_a, **_kw):
        raise AssertionError("upload() should not run during dry-run")

    monkeypatch.setattr(publish, "upload", boom)

    ckpt = _make_fake_checkpoint(tmp_path)
    plan = publish.publish_run(
        checkpoint_dir=ckpt,
        lang="zh",
        staging_dir=tmp_path / "stage",
        dry_run=True,
    )
    assert plan.onnx_dest.is_file()
