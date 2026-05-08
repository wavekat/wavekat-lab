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
