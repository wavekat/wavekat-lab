"""End-to-end ``wk-st run`` implementation.

Mirrors the cells of ``02_<letter>_*.ipynb`` exactly, importing the
heavy logic from ``notebooks/smart-turn/smart_turn.py``. If you change
training behavior, change it there — both the notebooks and the CLI
pick it up.

Output: under ``CHECKPOINT_DIR`` we write
- the HF Trainer best-by-F1 checkpoint
- ``threshold.json`` (already done by ``evaluate_and_save_threshold``)
- ``results.json`` — the run-output contract from the design doc
- ``run.lock.json`` — recipe + git sha + dataset hash
plus an entry in the global ``checkpoints/_ledger.jsonl``.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from functools import partial
from pathlib import Path

from wkst import ledger, tracking
from wkst._smart_turn import load_smart_turn
from wkst.config import RunConfig
from wkst.metrics import bootstrap_f1_ci, continuation_recall


def run(cfg: RunConfig) -> Path:
    """Train + evaluate one recipe on one dataset. Returns results.json path."""
    cfg.checkpoint_dir.mkdir(parents=True, exist_ok=True)

    smart_turn = load_smart_turn()
    import torch  # noqa: WPS433  -- heavy import gated by `train` extra
    from datasets import Audio, disable_progress_bars, load_dataset
    from transformers import (
        Trainer,
        TrainingArguments,
        WhisperFeatureExtractor,
    )

    disable_progress_bars()

    # ---- 1. Load dataset (train+val from cfg.dataset_dir, test optional override)
    train_val_files = {
        split: str(cfg.dataset_dir / f"{split}.parquet")
        for split in ("train", "validation")
        if (cfg.dataset_dir / f"{split}.parquet").exists()
    }
    if "train" not in train_val_files:
        raise FileNotFoundError(
            f"{cfg.dataset_dir}/train.parquet not found — "
            "did the adapt step finish?"
        )
    if cfg.test_dir is not None:
        test_path = cfg.test_dir / "test.parquet"
        if not test_path.exists():
            raise FileNotFoundError(
                f"--test-dir set to {cfg.test_dir} but test.parquet is missing."
            )
        test_files = {"test": str(test_path)}
        ds_main = load_dataset("parquet", data_files=train_val_files)
        ds_test = load_dataset("parquet", data_files=test_files)
        ds = {**ds_main, **ds_test}
    else:
        files = dict(train_val_files)
        if (cfg.dataset_dir / "test.parquet").exists():
            files["test"] = str(cfg.dataset_dir / "test.parquet")
        ds = load_dataset("parquet", data_files=files)

    for split in ds:
        ds[split] = ds[split].cast_column(
            "audio", Audio(sampling_rate=cfg.recipe.target_sr)
        )

    # ---- 2. Build / warm-start model
    device = smart_turn.pick_device()
    if cfg.warm_start_from is not None:
        if not cfg.warm_start_from.exists():
            raise FileNotFoundError(
                f"--warm-start-from not found: {cfg.warm_start_from}"
            )
        model = smart_turn.SmartTurnModel.from_pretrained(str(cfg.warm_start_from))
    else:
        model = smart_turn.build_model(cfg.recipe.base_model)

    pos_w = smart_turn.pos_weight_from_labels(ds["train"]["endpoint_bool"])
    model.set_pos_weight(pos_w)

    # ---- 3. Feature extraction + datasets
    feature_extractor = WhisperFeatureExtractor(chunk_length=cfg.recipe.chunk_length)

    augment_fn = None
    if cfg.recipe.augment is not None:
        a = cfg.recipe.augment
        augment_fn = partial(
            smart_turn.spec_augment,
            n_time_masks=a.n_time_masks,
            time_mask_max=a.time_mask_max,
            n_freq_masks=a.n_freq_masks,
            freq_mask_max=a.freq_mask_max,
        )

    train_dataset = smart_turn.SmartTurnDataset(
        ds["train"], feature_extractor,
        cfg.recipe.target_sr, cfg.recipe.chunk_length,
        augment=augment_fn,
    )
    eval_dataset = smart_turn.SmartTurnDataset(
        ds.get("validation", ds["train"]), feature_extractor,
        cfg.recipe.target_sr, cfg.recipe.chunk_length,
        augment=None,
    )

    # ---- 4. Train
    use_cuda = torch.cuda.is_available()
    training_args = TrainingArguments(
        output_dir=str(cfg.checkpoint_dir),
        run_name=f"{cfg.dataset_name}-{cfg.run_name}",
        num_train_epochs=cfg.recipe.epochs,
        per_device_train_batch_size=cfg.recipe.batch_size,
        per_device_eval_batch_size=cfg.recipe.eval_batch_size,
        gradient_accumulation_steps=cfg.recipe.grad_accum,
        learning_rate=cfg.recipe.learning_rate,
        warmup_ratio=cfg.recipe.warmup_ratio,
        weight_decay=cfg.recipe.weight_decay,
        lr_scheduler_type="cosine",
        eval_strategy="epoch",
        save_strategy="epoch",
        logging_steps=10,
        dataloader_num_workers=2 if use_cuda else 0,
        dataloader_pin_memory=use_cuda,
        bf16=use_cuda and torch.cuda.is_bf16_supported(),
        fp16=use_cuda and not torch.cuda.is_bf16_supported(),
        load_best_model_at_end=True,
        metric_for_best_model="f1",
        greater_is_better=True,
        save_total_limit=2,
        report_to="wandb" if os.environ.get("WANDB_API_KEY") else "none",
        seed=cfg.recipe.seed,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        compute_metrics=smart_turn.compute_metrics_with_threshold,
    )

    trainer.train()

    # ---- 5. Threshold sweep on val + save threshold.json
    threshold_payload = smart_turn.evaluate_and_save_threshold(
        trainer, eval_dataset, cfg.checkpoint_dir,
    )

    # ---- 6. Save model + feature extractor for downstream notebooks/CLI
    model.save_pretrained(cfg.checkpoint_dir)
    feature_extractor.save_pretrained(cfg.checkpoint_dir)

    # ---- 7. Score test set if present
    test_metrics = None
    if "test" in ds:
        test_dataset_for_score = ds["test"]
        scored = smart_turn.score_run(
            cfg.checkpoint_dir, test_dataset_for_score,
            cfg.recipe.target_sr, cfg.recipe.chunk_length,
            device, batch_size=cfg.recipe.eval_batch_size,
        )
        f1_ci = bootstrap_f1_ci(
            scored["labels"], scored["probs"], float(scored["threshold"]),
        )
        cont_r = continuation_recall(
            scored["labels"], scored["probs"], float(scored["threshold"]),
        )
        test_metrics = {
            "threshold": float(scored["threshold"]),
            "f1": float(scored["f1"]),
            "f1_ci95": [float(f1_ci.low), float(f1_ci.high)],
            "f1_ci_n_resamples": f1_ci.n_resamples,
            "continuation_recall": float(cont_r),
            "precision": float(scored["precision"]),
            "recall": float(scored["recall"]),
            "accuracy": float(scored["accuracy"]),
            "ap": float(scored["average_precision"]),
            "n": int(len(test_dataset_for_score)),
            "source": (
                str(cfg.test_dir) if cfg.test_dir is not None
                else str(cfg.dataset_dir)
            ),
        }

    # ---- 8. Persist results.json + run.lock.json + ledger entry
    results_path = _write_results(
        cfg=cfg,
        ds_sizes={split: len(ds[split]) for split in ds},
        threshold_payload=threshold_payload,
        test_metrics=test_metrics,
        pos_weight=float(pos_w),
    )

    ledger.append(
        run=f"{cfg.dataset_name}/{cfg.run_name}",
        results_path=results_path,
    )

    # ---- 9. W&B test-time logging (no-op if WANDB_API_KEY is unset).
    # HF Trainer started the run already; we attach + push the
    # post-train block it never saw.
    wandb_run = tracking.init_run(
        project="smart-turn",
        run_name=f"{cfg.dataset_name}-{cfg.run_name}",
        config={"recipe": cfg.recipe.as_dict(),
                "dataset": cfg.dataset_name,
                "run_name": cfg.run_name,
                "export_id": cfg.export_id},
        tags=[cfg.recipe.name, cfg.dataset_name],
    )
    if wandb_run is not None:
        if test_metrics is not None:
            tracking.log_test_metrics(wandb_run, test_metrics)
        tracking.log_test_metrics(
            wandb_run, {"val_threshold": threshold_payload.get("threshold")},
        )
    tracking.finish(wandb_run)

    return results_path


# -----------------------------------------------------------------------------
# Output writers
# -----------------------------------------------------------------------------


def _write_results(
    *,
    cfg: RunConfig,
    ds_sizes: dict[str, int],
    threshold_payload: dict,
    test_metrics: dict | None,
    pos_weight: float,
) -> Path:
    payload = {
        "run_name": f"{cfg.dataset_name}/{cfg.run_name}",
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": {
            "path": str(cfg.dataset_dir),
            "sha256": _hash_dataset(cfg.dataset_dir),
            "export_id": cfg.export_id,
            "n_train": ds_sizes.get("train", 0),
            "n_val": ds_sizes.get("validation", 0),
            "n_test": ds_sizes.get("test", 0),
        },
        "recipe": cfg.recipe.as_dict(),
        "git": _git_provenance(),
        "metrics": {
            "val": {
                "f1": threshold_payload.get("val_f1"),
                "f1_at_0.5": threshold_payload.get("val_f1_at_0.5"),
                "threshold": threshold_payload.get("threshold"),
            },
            "test": test_metrics,
        },
        "pos_weight": pos_weight,
        "warm_start_from": (
            str(cfg.warm_start_from) if cfg.warm_start_from else None
        ),
        "test_export_id": cfg.test_export_id,
    }
    results_path = cfg.checkpoint_dir / "results.json"
    results_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    lock = {
        "config": cfg.as_dict(),
        "git": payload["git"],
        "dataset_sha256": payload["dataset"]["sha256"],
    }
    (cfg.checkpoint_dir / "run.lock.json").write_text(
        json.dumps(lock, indent=2, ensure_ascii=False)
    )
    return results_path


def _hash_dataset(dataset_dir: Path) -> str:
    """Stable hash over metadata.json + parquet shards (not the audio bytes).

    Enough to detect "is this the same export I trained on" without
    paying re-hash-the-audio cost on every run.
    """
    h = hashlib.sha256()
    files = []
    for name in ("metadata.json",):
        p = dataset_dir / name
        if p.exists():
            files.append(p)
    for p in sorted(dataset_dir.glob("*.parquet")):
        files.append(p)
    for p in files:
        h.update(p.name.encode())
        h.update(b"\0")
        h.update(p.stat().st_size.to_bytes(8, "little"))
        h.update(int(p.stat().st_mtime).to_bytes(8, "little"))
    return h.hexdigest()


def _git_provenance() -> dict:
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain"],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
        )
        return {"sha": sha, "dirty": dirty}
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {"sha": None, "dirty": None}
