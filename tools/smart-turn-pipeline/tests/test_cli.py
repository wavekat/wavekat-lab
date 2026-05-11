"""CLI smoke tests — argument parsing only.

Avoids importing wkst.run so torch isn't required.
"""

from __future__ import annotations

import sys

import pytest

from wkst.__main__ import _parser


def test_help_prints_subcommand():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--help"])


def test_run_requires_recipe():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["run", "--export-id", "x"])


def test_run_requires_dataset_or_export_id():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["run", "--recipe", "baseline"])


def test_run_rejects_both_dataset_and_export_id():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args([
            "run", "--export-id", "x",
            "--dataset", "/tmp/ds", "--recipe", "baseline",
        ])


def test_run_rejects_unknown_recipe():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args([
            "run", "--export-id", "x", "--recipe", "no-such-recipe",
        ])


def test_run_accepts_export_id_path():
    parser = _parser()
    ns = parser.parse_args([
        "run", "--export-id", "abc123", "--recipe", "specaugment",
    ])
    assert ns.export_id == "abc123"
    assert ns.recipe == "specaugment"
    assert ns.dataset is None


def test_run_accepts_test_override():
    parser = _parser()
    ns = parser.parse_args([
        "run", "--export-id", "abc",
        "--recipe", "baseline",
        "--test", "/tmp/frozen-test",
    ])
    assert str(ns.test) == "/tmp/frozen-test"


def test_run_rejects_both_test_flags():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args([
            "run", "--export-id", "abc",
            "--recipe", "baseline",
            "--test", "/tmp/x",
            "--test-export-id", "y",
        ])


def test_compare_requires_runs():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["compare"])


def test_compare_accepts_multiple_runs():
    parser = _parser()
    ns = parser.parse_args([
        "compare", "--runs", "/tmp/a", "/tmp/b", "/tmp/c",
    ])
    assert [str(p) for p in ns.runs] == ["/tmp/a", "/tmp/b", "/tmp/c"]
    assert ns.tests is None
    assert ns.metric == "f1"


def test_compare_with_tests_switches_metric():
    parser = _parser()
    ns = parser.parse_args([
        "compare",
        "--runs", "/tmp/a",
        "--tests", "/tmp/t1", "/tmp/t2",
        "--metric", "ap",
        "--bootstrap-n", "200",
    ])
    assert [str(p) for p in ns.tests] == ["/tmp/t1", "/tmp/t2"]
    assert ns.metric == "ap"
    assert ns.bootstrap_n == 200


def test_compare_rejects_unknown_metric():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args([
            "compare", "--runs", "/tmp/a", "--metric", "made-up",
        ])


def test_export_requires_checkpoint_and_dataset():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["export"])
    with pytest.raises(SystemExit):
        parser.parse_args(["export", "--checkpoint", "/tmp/c"])
    with pytest.raises(SystemExit):
        parser.parse_args(["export", "--dataset", "/tmp/d"])


def test_export_accepts_full_args():
    parser = _parser()
    ns = parser.parse_args([
        "export",
        "--checkpoint", "/tmp/c",
        "--dataset", "/tmp/d",
        "--test", "/tmp/frozen",
        "--calibration-samples", "128",
        "--bench-runs", "50",
    ])
    assert str(ns.checkpoint) == "/tmp/c"
    assert ns.calibration_samples == 128
    assert ns.bench_runs == 50


def test_eval_pipecat_requires_onnx_and_test_source():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["eval-pipecat"])
    with pytest.raises(SystemExit):
        parser.parse_args(["eval-pipecat", "--pipecat-onnx", "/tmp/x.onnx"])


def test_eval_pipecat_rejects_both_test_flags():
    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args([
            "eval-pipecat",
            "--pipecat-onnx", "/tmp/x.onnx",
            "--test", "/tmp/d",
            "--test-export-id", "abc",
        ])


def test_eval_pipecat_accepts_local_test_dir():
    parser = _parser()
    ns = parser.parse_args([
        "eval-pipecat",
        "--pipecat-onnx", "/tmp/x.onnx",
        "--test", "/tmp/frozen-test",
    ])
    assert str(ns.pipecat_onnx) == "/tmp/x.onnx"
    assert str(ns.test) == "/tmp/frozen-test"
    assert ns.test_export_id is None
    assert ns.run_name == "pipecat-v3"
    assert ns.threshold == 0.5
    assert ns.feature_extractor == "openai/whisper-tiny"


def test_eval_pipecat_accepts_export_id_and_overrides():
    parser = _parser()
    ns = parser.parse_args([
        "eval-pipecat",
        "--pipecat-onnx", "/tmp/x.onnx",
        "--test-export-id", "7f862add",
        "--language", "en",
        "--run-name", "pipecat-v3.2-cpu",
        "--threshold", "0.55",
        "--bootstrap-n", "250",
        "--out", "/tmp/eval-out",
    ])
    assert ns.test_export_id == "7f862add"
    assert ns.language == "en"
    assert ns.run_name == "pipecat-v3.2-cpu"
    assert ns.threshold == 0.55
    assert ns.bootstrap_n == 250
    assert str(ns.out) == "/tmp/eval-out"


def test_report_print_only_flag():
    parser = _parser()
    ns = parser.parse_args(["report", "--print"])
    assert ns.print_only is True
    assert ns.readme is None


def test_report_accepts_readme_override():
    parser = _parser()
    ns = parser.parse_args(["report", "--readme", "/tmp/X.md"])
    assert str(ns.readme) == "/tmp/X.md"
