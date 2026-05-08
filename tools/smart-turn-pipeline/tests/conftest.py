"""Pytest fixtures: temporary repo root with notebooks/ + checkpoints/."""

from __future__ import annotations

import os
from pathlib import Path

import pytest


@pytest.fixture()
def fake_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Build a minimal wavekat-lab-shaped tree under tmp_path.

    Includes notebooks/smart-turn/smart_turn.py as an empty stub so the
    sys.path shim resolves without dragging torch in.
    """
    (tmp_path / "pyproject.toml").write_text("[project]\nname='fake'\n")
    (tmp_path / "notebooks" / "smart-turn").mkdir(parents=True)
    (tmp_path / "notebooks" / "smart-turn" / "smart_turn.py").write_text(
        "# stub for tests\n"
    )
    (tmp_path / "datasets").mkdir()
    (tmp_path / "snapshots").mkdir()
    (tmp_path / "checkpoints").mkdir()

    monkeypatch.setenv("WKST_REPO_ROOT", str(tmp_path))
    return tmp_path
