"""Lazy import shim for ``notebooks/smart-turn/smart_turn.py``.

The training/eval helpers live with the notebooks (so notebooks and
the CLI run identical code). This module adds that directory to
``sys.path`` once, then imports it.

We do this at call time rather than at package import so plain
``import wkst`` works without torch installed — only the `train` extra
needs the heavy deps.
"""

from __future__ import annotations

import importlib
import sys
from types import ModuleType

from wkst._paths import smart_turn_module_dir


def load_smart_turn() -> ModuleType:
    """Return the ``smart_turn`` module from the notebooks directory."""
    notebook_dir = smart_turn_module_dir()
    if not (notebook_dir / "smart_turn.py").is_file():
        raise RuntimeError(
            f"smart_turn.py not found at {notebook_dir}/smart_turn.py — "
            "is the wavekat-lab repo intact?"
        )
    sys_path_entry = str(notebook_dir)
    if sys_path_entry not in sys.path:
        sys.path.insert(0, sys_path_entry)
    return importlib.import_module("smart_turn")
