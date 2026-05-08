"""Resolve a wavekat-platform export id into a local dataset directory.

Two ingest knobs only — ``--export-id`` and ``--dataset-name``.
``--language``, ``--review-status``, ``--ratios`` belong with
``wk exports create`` and stay out of the wheel.

The wheel calls the ``wk`` CLI as a subprocess; we don't import the
platform's API client. This means whatever ``wk`` is already authed
with is what we use, and the ingest path fails loudly before any
training starts if ``wk`` is missing or unconfigured.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from wkst._paths import datasets_dir, snapshots_dir


class IngestError(RuntimeError):
    """Surfaces every ingest failure: missing CLI, bad export id, etc."""


_WK_BINARY_ENV = "WKST_WK_BINARY"  # let tests override the CLI path
_PROVENANCE_FILE = ".wkst-export.json"


@dataclass(frozen=True)
class IngestResult:
    """What the ingest produced. ``cached`` is True if nothing was downloaded."""

    dataset_dir: Path
    snapshot_dir: Path
    export_id: str
    dataset_name: str
    cached: bool


def slugify(name: str) -> str:
    """Filesystem-safe slug for a wavekat-platform export name."""
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "export"


def _wk_binary() -> str:
    import os

    return os.environ.get(_WK_BINARY_ENV, "wk")


def _check_wk_available() -> None:
    binary = _wk_binary()
    if shutil.which(binary) is None:
        raise IngestError(
            f"`{binary}` is not on PATH. Install wavekat-cli and run "
            f"`{binary} login` before re-running, or set "
            f"{_WK_BINARY_ENV}=/path/to/wk."
        )


def _run_wk(args: list[str]) -> str:
    """Run ``wk`` with the given args; return stdout. Raises IngestError on non-zero."""
    cmd = [_wk_binary(), *args]
    try:
        result = subprocess.run(
            cmd, check=True, capture_output=True, text=True
        )
    except FileNotFoundError as exc:
        raise IngestError(f"`{cmd[0]}` not found on PATH") from exc
    except subprocess.CalledProcessError as exc:
        raise IngestError(
            f"`{' '.join(cmd)}` failed ({exc.returncode}):\n{exc.stderr.strip()}"
        ) from exc
    return result.stdout


def _read_provenance(dataset_dir: Path) -> dict | None:
    p = dataset_dir / _PROVENANCE_FILE
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return None


def _write_provenance(dataset_dir: Path, *, export_id: str, snapshot_dir: Path) -> None:
    payload = {
        "export_id": export_id,
        "snapshot_dir": str(snapshot_dir),
    }
    (dataset_dir / _PROVENANCE_FILE).write_text(json.dumps(payload, indent=2))


def resolve_dataset(
    *,
    export_id: str | None = None,
    dataset_dir: Path | None = None,
    dataset_name: str | None = None,
    language: str = "zh",
) -> IngestResult:
    """Resolve a dataset spec into a concrete on-disk directory.

    Exactly one of ``export_id`` or ``dataset_dir`` must be set.

    With ``export_id``, runs ``wk exports download`` + ``wk exports
    adapt smart-turn`` (or skips both if the destination already
    matches that export id), and returns the adapted dataset path.

    With ``dataset_dir``, just validates that the path exists and
    looks like an adapted snapshot, and returns it unchanged.
    """
    if (export_id is None) == (dataset_dir is None):
        raise IngestError(
            "Pass exactly one of export_id or dataset_dir, not both."
        )

    if dataset_dir is not None:
        path = Path(dataset_dir).expanduser().resolve()
        if not path.exists():
            raise IngestError(f"Dataset dir does not exist: {path}")
        if not (path / "train.parquet").exists():
            raise IngestError(
                f"{path} does not look like an adapted smart-turn snapshot "
                "(no train.parquet). Did you run `wk exports adapt smart-turn`?"
            )
        prov = _read_provenance(path) or {}
        return IngestResult(
            dataset_dir=path,
            snapshot_dir=Path(prov.get("snapshot_dir") or path),
            export_id=prov.get("export_id") or "",
            dataset_name=path.name,
            cached=True,
        )

    # export_id path
    assert export_id is not None
    _check_wk_available()

    name = dataset_name or _derive_name_from_export(export_id)
    dest_dataset = datasets_dir() / name
    dest_snapshot = snapshots_dir() / name

    # Idempotent fast-path: dataset already adapted from this export id.
    if dest_dataset.exists() and (dest_dataset / "train.parquet").exists():
        prov = _read_provenance(dest_dataset)
        if prov and prov.get("export_id") == export_id:
            return IngestResult(
                dataset_dir=dest_dataset,
                snapshot_dir=dest_snapshot,
                export_id=export_id,
                dataset_name=name,
                cached=True,
            )

    dest_snapshot.mkdir(parents=True, exist_ok=True)
    _run_wk(["exports", "download", export_id, "--out", str(dest_snapshot)])

    dest_dataset.parent.mkdir(parents=True, exist_ok=True)
    _run_wk([
        "exports", "adapt", "smart-turn",
        "--export-dir", str(dest_snapshot),
        "--out", str(dest_dataset),
        "--language", language,
    ])

    if not (dest_dataset / "train.parquet").exists():
        raise IngestError(
            f"`wk exports adapt smart-turn` finished but {dest_dataset}/train.parquet "
            "is missing. Inspect the snapshot directory and re-run."
        )

    _write_provenance(dest_dataset, export_id=export_id, snapshot_dir=dest_snapshot)
    return IngestResult(
        dataset_dir=dest_dataset,
        snapshot_dir=dest_snapshot,
        export_id=export_id,
        dataset_name=name,
        cached=False,
    )


def _derive_name_from_export(export_id: str) -> str:
    """Try ``wk exports get`` JSON; fall back to a stable id-based slug.

    Anything that goes sideways here (no `wk`, malformed output, missing
    name field) silently falls back to ``export-<id-prefix>`` rather
    than failing the run — the dataset name is just a directory label.
    """
    try:
        out = _run_wk(["exports", "get", export_id, "--json"])
    except IngestError:
        return f"export-{export_id[:8]}"
    try:
        payload = json.loads(out) if isinstance(out, (str, bytes, bytearray)) else {}
    except json.JSONDecodeError:
        return f"export-{export_id[:8]}"
    if not isinstance(payload, dict):
        return f"export-{export_id[:8]}"
    name = payload.get("name") or payload.get("slug") or ""
    return slugify(name) if name else f"export-{export_id[:8]}"
