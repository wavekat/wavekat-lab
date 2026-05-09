"""Repo-root resolution.

The wheel writes into the repo's `datasets/`, `snapshots/`, and
`checkpoints/` directories — same paths the notebooks use — so the
notebooks and the CLI stay interchangeable. Resolution walks up from
this file's location until it finds a directory containing both
`notebooks/` and `checkpoints/` (or `pyproject.toml` at the root).
"""

from __future__ import annotations

import os
from pathlib import Path


def repo_root() -> Path:
    """Locate the wavekat-lab repo root by walking up from this file.

    Honors ``WKST_REPO_ROOT`` if set — useful for tests / non-default
    layouts. Raises ``RuntimeError`` if no plausible root is found.
    """
    env = os.environ.get("WKST_REPO_ROOT")
    if env:
        p = Path(env).resolve()
        if not p.exists():
            raise RuntimeError(f"WKST_REPO_ROOT does not exist: {p}")
        return p

    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "notebooks").is_dir() and (parent / "pyproject.toml").is_file():
            return parent
    raise RuntimeError(
        "Could not locate wavekat-lab repo root from "
        f"{here}. Set WKST_REPO_ROOT to override."
    )


def datasets_dir() -> Path:
    return repo_root() / "datasets"


def snapshots_dir() -> Path:
    return repo_root() / "snapshots"


def checkpoints_dir() -> Path:
    return repo_root() / "checkpoints"


def smart_turn_module_dir() -> Path:
    return repo_root() / "notebooks" / "smart-turn"
