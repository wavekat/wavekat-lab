"""``wk-st eval-pipecat`` — score a frozen pipecat-v3 ONNX on a test set.

Produces a ``results.json`` artifact in the same shape ``wk-st run``
emits (so downstream tooling — ``compare``, ``report``, the ledger,
the platform's PR-curve UI — treats pipecat-v3 as a first-class row
without needing a fake recipe checkpoint to compare against).

Inputs are deliberately the test-side knobs only: pick a test split
(``--test`` directory or ``--test-export-id``) and a pipecat ONNX.
No training, no val pass.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from wkst import ledger
from wkst._paths import checkpoints_dir
from wkst._smart_turn import load_smart_turn
from wkst.metrics import bootstrap_f1_ci, continuation_recall


@dataclass(frozen=True)
class EvalPipecatResult:
    results_path: Path
    run_name: str
    test_n: int
    test_f1: float
    test_ap: float
    pr_curve_n: int


def eval_pipecat(
    *,
    pipecat_onnx: Path,
    test_dir: Path,
    test_export_id: str | None = None,
    dataset_name: str | None = None,
    run_name: str = "pipecat-v3",
    feature_extractor: str = "openai/whisper-tiny",
    threshold: float = 0.5,
    target_sr: int = 16_000,
    chunk_length: int = 8,
    bootstrap_n: int = 1000,
    out_dir: Path | None = None,
) -> EvalPipecatResult:
    """Score ``pipecat_onnx`` on ``test_dir/test.parquet``; write results.json."""
    from datasets import Audio, disable_progress_bars, load_dataset

    smart_turn = load_smart_turn()
    disable_progress_bars()

    pipecat_onnx = Path(pipecat_onnx).expanduser().resolve()
    if not pipecat_onnx.exists():
        raise FileNotFoundError(f"pipecat ONNX not found: {pipecat_onnx}")

    test_dir = Path(test_dir).expanduser().resolve()
    test_parquet = test_dir / "test.parquet"
    if not test_parquet.exists():
        raise FileNotFoundError(
            f"{test_parquet} missing — pass a directory containing test.parquet."
        )

    ds_name = dataset_name or test_dir.name
    out_dir = (
        Path(out_dir).expanduser().resolve()
        if out_dir is not None
        else checkpoints_dir() / ds_name / run_name
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    ds = load_dataset("parquet", data_files={"test": str(test_parquet)})
    ds = ds.cast_column("audio", Audio(sampling_rate=target_sr))
    test_split = ds["test"]

    scored = smart_turn.score_onnx(
        pipecat_onnx, feature_extractor,
        test_split, target_sr, chunk_length, threshold=threshold,
    )
    f1_ci = bootstrap_f1_ci(
        scored["labels"], scored["probs"], threshold, n_resamples=bootstrap_n,
    )
    cont_r = continuation_recall(
        scored["labels"], scored["probs"], threshold,
    )

    test_metrics = {
        "threshold": float(threshold),
        "f1": float(scored["f1"]),
        "f1_ci95": [float(f1_ci.low), float(f1_ci.high)],
        "f1_ci_n_resamples": f1_ci.n_resamples,
        "continuation_recall": float(cont_r),
        "precision": float(scored["precision"]),
        "recall": float(scored["recall"]),
        "accuracy": float(scored["accuracy"]),
        "ap": float(scored["average_precision"]),
        "n": int(len(test_split)),
        "source": str(test_dir),
        "pr_curve": scored.get("pr_curve", {"n": 0, "points": []}),
    }

    n_test_records = _count_parquet_rows(test_parquet, fallback=len(test_split))
    n_train_records = _count_parquet_rows(test_dir / "train.parquet", fallback=0)
    n_val_records = _count_parquet_rows(test_dir / "validation.parquet", fallback=0)

    payload = {
        "run_name": f"{ds_name}/{run_name}",
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": {
            "path": str(test_dir),
            "sha256": None,
            "export_id": test_export_id,
            "n_train": n_train_records,
            "n_val": n_val_records,
            "n_test": n_test_records,
        },
        "recipe": {
            "name": run_name,
            "kind": "pipecat-onnx",
            "onnx_path": str(pipecat_onnx),
            "feature_extractor": feature_extractor,
            "threshold": float(threshold),
            "target_sr": target_sr,
            "chunk_length": chunk_length,
        },
        "git": None,
        "metrics": {
            "val": None,
            "test": test_metrics,
        },
        "pos_weight": None,
        "warm_start_from": None,
        "test_export_id": test_export_id,
    }

    results_path = out_dir / "results.json"
    results_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    ledger.append(
        run=f"{ds_name}/{run_name}",
        results_path=results_path,
    )

    return EvalPipecatResult(
        results_path=results_path,
        run_name=f"{ds_name}/{run_name}",
        test_n=test_metrics["n"],
        test_f1=test_metrics["f1"],
        test_ap=test_metrics["ap"],
        pr_curve_n=int(test_metrics["pr_curve"].get("n", 0)),
    )


def _count_parquet_rows(path: Path, *, fallback: int) -> int:
    """Best-effort row count without loading the full file. Cheap enough."""
    if not path.exists():
        return 0
    try:
        import pyarrow.parquet as pq  # noqa: WPS433
        return int(pq.ParquetFile(str(path)).metadata.num_rows)
    except Exception:
        return fallback
