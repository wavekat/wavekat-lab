"""``wk-st re-eval`` — back-fill ``metrics.{val,test}.pr_curve`` into an existing run.

Re-runs ``score_run`` against the saved checkpoint on the val (and
optionally test) parquet, then overwrites only the ``pr_curve`` field on
each split inside ``results.json``. Scalars and recipe metadata are left
alone — this is the back-fill path for runs that finished before commit
e20f7a0 added the curves, or for any time you want to regenerate the
curve without retraining.

Idempotent: same checkpoint + same data → same probs → same curve.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ReEvalResult:
    results_path: Path
    val_curve_n: int
    test_curve_n: int


def reeval(
    *,
    checkpoint_dir: Path,
    dataset_dir: Path,
    test_dir: Path | None = None,
    target_sr: int = 16_000,
    chunk_length: int = 8,
    batch_size: int = 16,
) -> ReEvalResult:
    """Re-score val (+ test) on a saved checkpoint and patch ``results.json``."""
    from datasets import Audio, disable_progress_bars, load_dataset

    from wkst._smart_turn import load_smart_turn

    smart_turn = load_smart_turn()
    disable_progress_bars()

    checkpoint_dir = Path(checkpoint_dir).expanduser().resolve()
    dataset_dir = Path(dataset_dir).expanduser().resolve()
    results_path = checkpoint_dir / "results.json"
    if not results_path.exists():
        raise FileNotFoundError(
            f"{results_path} missing — re-eval needs a results.json to patch. "
            "Run `wk-st run` first."
        )

    val_parquet = dataset_dir / "validation.parquet"
    if not val_parquet.exists():
        raise FileNotFoundError(
            f"{val_parquet} missing — can't re-eval val curve "
            f"(expected validation.parquet under {dataset_dir})."
        )

    test_source = test_dir or dataset_dir
    test_parquet = test_source / "test.parquet"

    files = {"validation": str(val_parquet)}
    if test_parquet.exists():
        files["test"] = str(test_parquet)
    ds = load_dataset("parquet", data_files=files)
    for split in ds:
        ds[split] = ds[split].cast_column("audio", Audio(sampling_rate=target_sr))

    device = smart_turn.pick_device()

    val_scored = smart_turn.score_run(
        checkpoint_dir, ds["validation"],
        target_sr, chunk_length, device, batch_size=batch_size,
    )
    test_scored = (
        smart_turn.score_run(
            checkpoint_dir, ds["test"],
            target_sr, chunk_length, device, batch_size=batch_size,
        )
        if "test" in ds else None
    )

    payload = json.loads(results_path.read_text())
    metrics = payload.setdefault("metrics", {})

    val_block = metrics.get("val")
    if not isinstance(val_block, dict):
        val_block = {}
        metrics["val"] = val_block
    val_block["pr_curve"] = val_scored["pr_curve"]

    test_curve_n = 0
    if test_scored is not None:
        test_block = metrics.get("test")
        if not isinstance(test_block, dict):
            test_block = {}
            metrics["test"] = test_block
        test_block["pr_curve"] = test_scored["pr_curve"]
        test_curve_n = test_scored["pr_curve"]["n"]

    results_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    return ReEvalResult(
        results_path=results_path,
        val_curve_n=val_scored["pr_curve"]["n"],
        test_curve_n=test_curve_n,
    )
