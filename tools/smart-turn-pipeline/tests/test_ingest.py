"""Ingest tests — subprocess to ``wk`` is mocked.

We never actually shell out in CI; tests verify argument plumbing,
idempotency, provenance writing, and error paths.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from wkst import ingest
from wkst.ingest import IngestError, resolve_dataset, slugify


def test_slugify_handles_spaces_and_punctuation():
    assert slugify("Smart Turn ZH 2026-05-08") == "smart-turn-zh-2026-05-08"
    assert slugify("   ") == "export"
    assert slugify("a!!!b") == "a-b"


def test_resolve_dataset_requires_exactly_one_source(fake_repo):
    with pytest.raises(IngestError, match="exactly one"):
        resolve_dataset()
    with pytest.raises(IngestError, match="exactly one"):
        resolve_dataset(export_id="x", dataset_dir=Path("/tmp"))


def test_resolve_dataset_rejects_missing_dir(fake_repo):
    with pytest.raises(IngestError, match="does not exist"):
        resolve_dataset(dataset_dir=fake_repo / "datasets" / "missing")


def test_resolve_dataset_rejects_unadapted_dir(fake_repo):
    bad = fake_repo / "datasets" / "raw"
    bad.mkdir()
    (bad / "metadata.json").write_text("{}")
    with pytest.raises(IngestError, match="adapted smart-turn snapshot"):
        resolve_dataset(dataset_dir=bad)


def test_resolve_dataset_passes_through_local_dir(fake_repo):
    good = fake_repo / "datasets" / "smart-turn-zh-0501"
    good.mkdir()
    (good / "train.parquet").write_bytes(b"")
    res = resolve_dataset(dataset_dir=good)
    assert res.dataset_dir == good
    assert res.cached is True
    assert res.dataset_name == "smart-turn-zh-0501"


def test_resolve_dataset_uses_provenance_when_present(fake_repo):
    good = fake_repo / "datasets" / "smart-turn-zh-0501"
    good.mkdir()
    (good / "train.parquet").write_bytes(b"")
    (good / ".wkst-export.json").write_text(json.dumps({"export_id": "abc123"}))
    res = resolve_dataset(dataset_dir=good)
    assert res.export_id == "abc123"


def test_export_id_skipped_when_already_cached(fake_repo, monkeypatch):
    monkeypatch.setenv("WKST_WK_BINARY", "echo")
    dest = fake_repo / "datasets" / "smart-turn-zh-2026-05-08"
    dest.mkdir()
    (dest / "train.parquet").write_bytes(b"")
    (dest / ".wkst-export.json").write_text(
        json.dumps({"export_id": "7c1e2f3a"})
    )

    calls: list[list[str]] = []

    def fake_run(args, *, capture=False):
        calls.append(list(args))
        if args[:2] == ["exports", "get"]:
            return json.dumps({"name": "smart-turn-zh 2026-05-08"})
        return ""

    with patch.object(ingest, "_run_wk", side_effect=fake_run):
        res = resolve_dataset(export_id="7c1e2f3a")

    download_called = any(a[:2] == ["exports", "download"] for a in calls)
    adapt_called = any(a[:3] == ["exports", "adapt", "smart-turn"] for a in calls)
    assert not download_called
    assert not adapt_called
    assert res.cached is True
    assert res.dataset_dir == dest


def test_export_id_runs_download_and_adapt(fake_repo, monkeypatch):
    monkeypatch.setenv("WKST_WK_BINARY", "echo")  # passes shutil.which

    def fake_run(args, *, capture=False):
        # Simulate `wk exports adapt smart-turn` producing a train.parquet.
        if args[:3] == ["exports", "adapt", "smart-turn"]:
            out_idx = args.index("--out") + 1
            out_dir = Path(args[out_idx])
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "train.parquet").write_bytes(b"")
        if args[:2] == ["exports", "get"]:
            return json.dumps({"name": "smart-turn-zh 2026-05-08"})
        return ""

    with patch.object(ingest, "_run_wk", side_effect=fake_run):
        res = resolve_dataset(export_id="7c1e2f3a")

    assert res.cached is False
    assert res.dataset_name == "smart-turn-zh-2026-05-08"
    assert res.dataset_dir.exists()
    assert (res.dataset_dir / "train.parquet").exists()

    prov = json.loads((res.dataset_dir / ".wkst-export.json").read_text())
    assert prov["export_id"] == "7c1e2f3a"


def test_export_id_with_dataset_name_override(fake_repo, monkeypatch):
    monkeypatch.setenv("WKST_WK_BINARY", "echo")

    def fake_run(args, *, capture=False):
        if args[:3] == ["exports", "adapt", "smart-turn"]:
            out_dir = Path(args[args.index("--out") + 1])
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "train.parquet").write_bytes(b"")
        return ""

    with patch.object(ingest, "_run_wk", side_effect=fake_run):
        res = resolve_dataset(
            export_id="abc", dataset_name="smart-turn-zh-0504"
        )

    assert res.dataset_name == "smart-turn-zh-0504"
    assert res.dataset_dir.name == "smart-turn-zh-0504"


def test_missing_wk_binary_fails_loudly(fake_repo, monkeypatch):
    monkeypatch.setenv("WKST_WK_BINARY", "definitely-not-on-path-xyzzy")
    with pytest.raises(IngestError, match="not on PATH"):
        resolve_dataset(export_id="abc")


def test_adapt_step_must_produce_train_parquet(fake_repo, monkeypatch):
    monkeypatch.setenv("WKST_WK_BINARY", "echo")

    with patch.object(ingest, "_run_wk", return_value=""):
        with pytest.raises(IngestError, match="train.parquet is missing"):
            resolve_dataset(
                export_id="abc", dataset_name="smart-turn-zh-broken"
            )
