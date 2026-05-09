"""Tracking tests — wandb is mocked; we never call the real client."""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock

import pytest

from wkst import tracking


def test_is_enabled_follows_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("WANDB_API_KEY", raising=False)
    assert tracking.is_enabled() is False
    monkeypatch.setenv("WANDB_API_KEY", "abc")
    assert tracking.is_enabled() is True


def test_init_run_returns_none_without_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("WANDB_API_KEY", raising=False)
    assert tracking.init_run(project="p", run_name="r") is None


def test_init_run_returns_none_when_wandb_missing(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("WANDB_API_KEY", "abc")
    monkeypatch.setitem(sys.modules, "wandb", None)
    # importing None raises ImportError under our shim
    assert tracking.init_run(project="p", run_name="r") is None


def test_init_run_starts_new_run(monkeypatch: pytest.MonkeyPatch):
    fake = types.SimpleNamespace()
    fake.run = None
    fake.init = MagicMock(return_value=MagicMock(name="wandb_run"))
    monkeypatch.setitem(sys.modules, "wandb", fake)
    monkeypatch.setenv("WANDB_API_KEY", "abc")

    run = tracking.init_run(
        project="smart-turn", run_name="r1",
        config={"x": 1}, tags=["a"],
    )
    fake.init.assert_called_once()
    assert run is fake.init.return_value


def test_init_run_attaches_to_existing(monkeypatch: pytest.MonkeyPatch):
    existing = MagicMock(name="active_run")
    existing.tags = ("trainer",)
    fake = types.SimpleNamespace(run=existing, init=MagicMock())
    monkeypatch.setitem(sys.modules, "wandb", fake)
    monkeypatch.setenv("WANDB_API_KEY", "abc")

    run = tracking.init_run(project="p", run_name="r", tags=["test"])
    fake.init.assert_not_called()
    assert run is existing
    assert "test" in existing.tags
    assert "trainer" in existing.tags


def test_log_test_metrics_separates_scalars_and_summary():
    run = MagicMock()
    run.summary = {}
    tracking.log_test_metrics(run, {
        "f1": 0.85,
        "f1_ci95": [0.81, 0.89],
        "n": 200,
        "source": "/path",
    })
    # numeric scalars go via .log under test/*
    run.log.assert_called_once_with({
        "test/f1": 0.85,
        "test/n": 200.0,
    })
    assert run.summary["test/f1_ci95"] == [0.81, 0.89]
    assert run.summary["test/source"] == "/path"


def test_log_test_metrics_noop_on_none():
    # No exception expected — caller-friendly when tracking is off.
    tracking.log_test_metrics(None, {"f1": 0.9})


def test_finish_swallows_errors():
    run = MagicMock()
    run.finish.side_effect = RuntimeError("boom")
    tracking.finish(run)  # must not raise


def test_finish_noop_on_none():
    tracking.finish(None)
