"""``wk-st compare`` — read mode and cross-eval mode.

**Read mode** (cheap, no torch). Given a list of checkpoint dirs,
loads each one's ``results.json`` and prints a side-by-side table:

    wk-st compare \\
        --runs checkpoints/smart-turn-zh-0501/specaugment \\
               checkpoints/smart-turn-zh-0502/specaugment

**Cross-eval mode** (heavy, needs torch + the model checkpoints).
Adds ``--tests <dataset_dir>...``: every checkpoint is scored on
every test dataset, producing the NxM table that doc 04 said we
needed to disentangle the AP regression.

    wk-st compare \\
        --runs   checkpoints/smart-turn-zh-0501/specaugment \\
                 checkpoints/smart-turn-zh-0502/specaugment \\
        --tests  datasets/smart-turn-zh-0501 \\
                 datasets/smart-turn-zh-0502 \\
                 datasets/smart-turn-zh-test-frozen \\
        --out    reports/0503-cross-eval.md

Outputs:
- A markdown table to stdout (and to ``--out`` if given).
- A JSON dump of the same data alongside the markdown for downstream
  consumers (`<--out>.json`).
- Optional overlaid PR-curve PNG at ``<--out>.png`` when matplotlib
  is available (cross-eval mode only).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from wkst.metrics import bootstrap_f1_ci, continuation_recall


@dataclass(frozen=True)
class RunCard:
    """Minimal view of a checkpoint dir for the compare table."""

    label: str           # human-friendly column / row label
    checkpoint_dir: Path
    results_path: Path
    results: dict


# -----------------------------------------------------------------------------
# Read mode — load results.json, build a table, no torch
# -----------------------------------------------------------------------------


def load_run_cards(checkpoint_dirs: list[Path]) -> list[RunCard]:
    """Read each checkpoint dir's ``results.json``.

    Missing or malformed files raise — we'd rather fail loudly than
    silently print zeros for runs that didn't actually finish.
    """
    cards: list[RunCard] = []
    for ckpt in checkpoint_dirs:
        ckpt = Path(ckpt).expanduser().resolve()
        results_path = ckpt / "results.json"
        if not results_path.exists():
            raise FileNotFoundError(
                f"{results_path} not found. Has this run finished? "
                "Cross-eval can populate it; see `wk-st compare --tests …`."
            )
        results = json.loads(results_path.read_text())
        label = results.get("run_name") or ckpt.name
        cards.append(
            RunCard(
                label=label,
                checkpoint_dir=ckpt,
                results_path=results_path,
                results=results,
            )
        )
    return cards


def render_read_table(cards: list[RunCard]) -> str:
    """Markdown summary of each run's recorded test metrics."""
    headers = [
        "run", "test source", "n",
        "F1", "CI95", "cont-recall", "AP", "thr",
    ]
    lines = ["| " + " | ".join(headers) + " |",
             "|" + "|".join(["---"] * len(headers)) + "|"]
    for card in cards:
        m = (card.results.get("metrics") or {}).get("test") or {}
        ci = m.get("f1_ci95") or []
        ci_str = f"{ci[0]:.3f}–{ci[1]:.3f}" if len(ci) == 2 else "—"
        lines.append("| " + " | ".join([
            card.label,
            _short_path(m.get("source") or "—"),
            _maybe_int(m.get("n")),
            _maybe_float(m.get("f1"), 3),
            ci_str,
            _maybe_float(m.get("continuation_recall"), 3),
            _maybe_float(m.get("ap"), 3),
            _maybe_float(m.get("threshold"), 2),
        ]) + " |")
    return "\n".join(lines)


# -----------------------------------------------------------------------------
# Cross-eval — score each run × each test, needs torch
# -----------------------------------------------------------------------------


def cross_eval(
    *,
    checkpoint_dirs: list[Path],
    test_dirs: list[Path],
    pipecat_onnx: Path | None = None,
    target_sr: int = 16_000,
    chunk_length: int = 8,
    bootstrap_n: int = 1000,
) -> dict:
    """Score every checkpoint on every test dataset.

    Returns ``{"rows": [...], "tests": [...], "runs": [...]}`` — one
    row per (run, test) cell. Heavy: imports torch / datasets, loads
    each checkpoint into memory once and reuses across tests.
    """
    from datasets import Audio, disable_progress_bars, load_dataset
    from wkst._smart_turn import load_smart_turn

    smart_turn = load_smart_turn()
    disable_progress_bars()

    # Pre-load test datasets once (audio decoded lazily).
    test_specs: list[tuple[str, object]] = []
    for td in test_dirs:
        td = Path(td).expanduser().resolve()
        parquet = td / "test.parquet"
        if not parquet.exists():
            raise FileNotFoundError(f"{parquet} missing — not an adapted snapshot.")
        ds = load_dataset("parquet", data_files={"test": str(parquet)})
        ds = ds.cast_column("audio", Audio(sampling_rate=target_sr))
        test_specs.append((td.name, ds["test"]))

    cards = load_run_cards(checkpoint_dirs)
    device = smart_turn.pick_device()
    rows: list[dict] = []

    for card in cards:
        for test_name, test_split in test_specs:
            scored = smart_turn.score_run(
                card.checkpoint_dir, test_split,
                target_sr, chunk_length, device,
            )
            ci = bootstrap_f1_ci(
                scored["labels"], scored["probs"],
                float(scored["threshold"]), n_resamples=bootstrap_n,
            )
            cont_r = continuation_recall(
                scored["labels"], scored["probs"], float(scored["threshold"]),
            )
            rows.append({
                "run": card.label,
                "test": test_name,
                "n": int(len(test_split)),
                "threshold": float(scored["threshold"]),
                "f1": float(scored["f1"]),
                "f1_ci95": [float(ci.low), float(ci.high)],
                "continuation_recall": float(cont_r),
                "ap": float(scored["average_precision"]),
                "precision": float(scored["precision"]),
                "recall": float(scored["recall"]),
            })

    if pipecat_onnx is not None:
        for test_name, test_split in test_specs:
            scored = smart_turn.score_onnx(
                pipecat_onnx, "openai/whisper-tiny",
                test_split, target_sr, chunk_length, threshold=0.5,
            )
            ci = bootstrap_f1_ci(
                scored["labels"], scored["probs"], 0.5, n_resamples=bootstrap_n,
            )
            cont_r = continuation_recall(
                scored["labels"], scored["probs"], 0.5,
            )
            rows.append({
                "run": "pipecat-v3 (zero-shot)",
                "test": test_name,
                "n": int(len(test_split)),
                "threshold": 0.5,
                "f1": float(scored["f1"]),
                "f1_ci95": [float(ci.low), float(ci.high)],
                "continuation_recall": float(cont_r),
                "ap": float(scored["average_precision"]),
                "precision": float(scored["precision"]),
                "recall": float(scored["recall"]),
            })

    run_labels = [c.label for c in cards] + (
        ["pipecat-v3 (zero-shot)"] if pipecat_onnx is not None else []
    )
    return {
        "rows": rows,
        "runs": run_labels,
        "tests": [name for name, _ in test_specs],
    }


def render_cross_eval_table(grid: dict, *, metric: str = "f1") -> str:
    """NxM markdown table — one row per run, one column per test set."""
    runs = grid["runs"]
    tests = grid["tests"]
    by_cell = {(r["run"], r["test"]): r for r in grid["rows"]}

    headers = ["run"] + tests
    lines = ["| " + " | ".join(headers) + " |",
             "|" + "|".join(["---"] * len(headers)) + "|"]
    for run in runs:
        row = [run]
        for test in tests:
            cell = by_cell.get((run, test))
            if cell is None:
                row.append("—")
                continue
            value = cell.get(metric)
            if value is None:
                row.append("—")
            else:
                row.append(f"{value:.3f}")
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


# -----------------------------------------------------------------------------
# helpers
# -----------------------------------------------------------------------------


def _short_path(s: str) -> str:
    if not s or s == "—":
        return "—"
    return Path(s).name or s


def _maybe_float(v, digits: int) -> str:
    if v is None:
        return "—"
    try:
        return f"{float(v):.{digits}f}"
    except (TypeError, ValueError):
        return str(v)


def _maybe_int(v) -> str:
    if v is None:
        return "—"
    try:
        return str(int(v))
    except (TypeError, ValueError):
        return str(v)
