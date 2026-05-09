"""Append-only run ledger.

One JSON line per finished run, written to
``checkpoints/_ledger.jsonl``. ``wk-st report`` reads this back to
rebuild the README scorecard.

Schema is intentionally tiny; the heavy data lives in the run's
``results.json``, which is referenced by relative path. That keeps the
ledger small enough to grep / read by hand.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path
from typing import Iterator

from wkst._paths import checkpoints_dir

LEDGER_NAME = "_ledger.jsonl"


def _ledger_path(root: Path | None = None) -> Path:
    return (root or checkpoints_dir()) / LEDGER_NAME


def append(
    *,
    run: str,
    results_path: Path,
    extra: dict | None = None,
    root: Path | None = None,
) -> Path:
    """Append one entry. Returns the ledger file path.

    ``run`` is the run identifier (e.g. ``smart-turn-zh-0503/specaugment``).
    ``results_path`` is recorded relative to ``root`` (the checkpoints
    dir) so the ledger stays portable across machines that mount the
    checkpoints elsewhere.
    """
    ledger = _ledger_path(root)
    ledger.parent.mkdir(parents=True, exist_ok=True)

    results_path = Path(results_path).resolve()
    base = (root or checkpoints_dir()).resolve()
    try:
        rel = results_path.relative_to(base)
        results_field = str(rel)
    except ValueError:
        results_field = str(results_path)

    entry = {
        "ts": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "run": run,
        "results": results_field,
    }
    if extra:
        entry["extra"] = extra

    with ledger.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return ledger


def read(root: Path | None = None) -> Iterator[dict]:
    """Yield every ledger entry, oldest first. Missing file ⇒ empty iterator."""
    ledger = _ledger_path(root)
    if not ledger.exists():
        return iter(())

    def _gen():
        with ledger.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    yield json.loads(line)

    return _gen()
