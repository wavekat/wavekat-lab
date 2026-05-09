"""``wk-st export`` — FP32 ONNX + INT8 quant + drift + bench.

Mirrors ``notebooks/smart-turn/04_export.ipynb`` cell-for-cell. The
artifact under ``checkpoint_dir/onnx/smart-turn-int8.onnx`` is what
plugs into pipecat's ``SmartTurnAnalyzer`` for on-device end-of-turn
detection.

The export block is appended to the run's ``results.json`` so a
checkpoint's full lifecycle (train → calibrate → quantize → bench)
is queryable from one file.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from wkst import tracking
from wkst._smart_turn import load_smart_turn


@dataclass(frozen=True)
class ExportResult:
    fp32_onnx: Path
    int8_onnx: Path
    block: dict


def export_run(
    *,
    checkpoint_dir: Path,
    dataset_dir: Path,
    test_dir: Path | None = None,
    target_sr: int = 16_000,
    chunk_length: int = 8,
    onnx_opset: int = 18,
    calibration_samples: int = 256,
    bench_runs: int = 100,
    bench_warmup: int = 10,
) -> ExportResult:
    """Export FP32 + INT8 ONNX, score on the test set, bench latency.

    Updates ``checkpoint_dir / results.json`` with a new ``export``
    block; ledger entry is left alone (the run is already on the
    ledger from training).
    """
    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    import torch.nn as nn
    from datasets import Audio, disable_progress_bars, load_dataset
    from sklearn.metrics import (
        accuracy_score,
        f1_score,
        precision_score,
        recall_score,
    )
    from transformers import WhisperFeatureExtractor

    smart_turn = load_smart_turn()
    disable_progress_bars()

    checkpoint_dir = Path(checkpoint_dir).expanduser().resolve()
    dataset_dir = Path(dataset_dir).expanduser().resolve()
    artifacts_dir = checkpoint_dir / "onnx"
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    threshold_path = checkpoint_dir / "threshold.json"
    if threshold_path.exists():
        threshold = float(json.loads(threshold_path.read_text())["threshold"])
        threshold_source = "threshold.json"
    else:
        threshold = 0.5
        threshold_source = "default"

    # ---- 1. Load splits we need: train (calibration), test (drift)
    test_source = test_dir or dataset_dir
    parquet_files: dict[str, str] = {}
    if (dataset_dir / "train.parquet").exists():
        parquet_files["train"] = str(dataset_dir / "train.parquet")
    if (test_source / "test.parquet").exists():
        parquet_files["test"] = str(test_source / "test.parquet")
    else:
        raise FileNotFoundError(
            f"{test_source}/test.parquet missing — can't compute drift "
            "without a held-out test set."
        )
    ds = load_dataset("parquet", data_files=parquet_files)
    for split in ds:
        ds[split] = ds[split].cast_column(
            "audio", Audio(sampling_rate=target_sr)
        )

    # ---- 2. Reload model + feature extractor saved by `wk-st run`
    device = smart_turn.pick_device()
    model = smart_turn.SmartTurnModel.from_pretrained(checkpoint_dir).to(device).eval()
    feature_extractor = WhisperFeatureExtractor.from_pretrained(checkpoint_dir)

    test_dataset = smart_turn.SmartTurnDataset(
        ds["test"], feature_extractor, target_sr, chunk_length, augment=None,
    )
    train_dataset = (
        smart_turn.SmartTurnDataset(
            ds["train"], feature_extractor, target_sr, chunk_length, augment=None,
        )
        if "train" in ds else test_dataset
    )

    # ---- 3. FP32 ONNX export
    class _ONNXWrapper(nn.Module):
        def __init__(self, model_):
            super().__init__()
            self.model = model_

        def forward(self, input_features):  # noqa: D401
            return self.model(input_features)["logits"].unsqueeze(-1)

    onnx_fp32 = artifacts_dir / "smart-turn.onnx"
    wrapper = _ONNXWrapper(model.cpu()).eval()
    dummy = torch.randn(1, 80, chunk_length * 100)
    torch.onnx.export(
        wrapper, (dummy,), str(onnx_fp32),
        opset_version=onnx_opset,
        input_names=["input_features"],
        output_names=["logits"],
        dynamic_axes={"input_features": {0: "batch"}, "logits": {0: "batch"}},
        do_constant_folding=False,
        dynamo=False,
    )
    onnx.checker.check_model(onnx.load(str(onnx_fp32)))

    sess_fp32 = ort.InferenceSession(str(onnx_fp32), providers=["CPUExecutionProvider"])
    out_fp32_dummy = sess_fp32.run(None, {"input_features": dummy.numpy()})[0]

    # ---- 4. INT8 static quantization with entropy calibration
    from onnxruntime.quantization import (
        CalibrationDataReader,
        CalibrationMethod,
        QuantFormat,
        QuantType,
        quant_pre_process,
        quantize_static,
    )

    class _Calib(CalibrationDataReader):
        def __init__(self, dataset, n_samples):
            rng = np.random.default_rng(42)
            n = min(n_samples, len(dataset))
            idx = rng.choice(len(dataset), size=n, replace=False)
            self.samples = [
                {"input_features": dataset[int(i)]["input_features"]
                    .unsqueeze(0).numpy()}
                for i in idx
            ]
            self.cursor = 0

        def get_next(self):
            if self.cursor >= len(self.samples):
                return None
            self.cursor += 1
            return self.samples[self.cursor - 1]

        def rewind(self):
            self.cursor = 0

    pre_path = artifacts_dir / "smart-turn-pre.onnx"
    quant_pre_process(str(onnx_fp32), str(pre_path), skip_symbolic_shape=True)
    onnx_int8 = artifacts_dir / "smart-turn-int8.onnx"
    quantize_static(
        model_input=str(pre_path),
        model_output=str(onnx_int8),
        calibration_data_reader=_Calib(train_dataset, calibration_samples),
        quant_format=QuantFormat.QDQ,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        per_channel=True,
        calibrate_method=CalibrationMethod.Entropy,
        op_types_to_quantize=["Conv", "MatMul", "Gemm"],
    )
    pre_path.unlink()

    sess_int8 = ort.InferenceSession(str(onnx_int8), providers=["CPUExecutionProvider"])
    out_int8_dummy = sess_int8.run(None, {"input_features": dummy.numpy()})[0]

    # ---- 5. Drift on test set
    def _score(sess, dataset):
        probs, labels = [], []
        for i in range(len(dataset)):
            item = dataset[i]
            feats = item["input_features"].unsqueeze(0).numpy()
            probs.append(float(sess.run(None, {"input_features": feats})[0][0, 0]))
            labels.append(int(item["labels"]))
        probs_np = np.asarray(probs)
        labels_np = np.asarray(labels, dtype=int)
        preds = (probs_np > threshold).astype(int)
        return {
            "accuracy": float(accuracy_score(labels_np, preds)),
            "precision": float(precision_score(labels_np, preds, zero_division=0)),
            "recall": float(recall_score(labels_np, preds, zero_division=0)),
            "f1": float(f1_score(labels_np, preds, zero_division=0)),
        }

    fp32_metrics = _score(sess_fp32, test_dataset)
    int8_metrics = _score(sess_int8, test_dataset)

    # ---- 6. Latency benchmark
    def _bench(path: Path) -> dict:
        sess = ort.InferenceSession(
            str(path), providers=["CPUExecutionProvider"],
        )
        x = np.random.randn(1, 80, chunk_length * 100).astype(np.float32)
        for _ in range(bench_warmup):
            sess.run(None, {"input_features": x})
        times: list[float] = []
        for _ in range(bench_runs):
            t0 = time.perf_counter()
            sess.run(None, {"input_features": x})
            times.append((time.perf_counter() - t0) * 1000)
        arr = np.asarray(times)
        return {
            "mean_ms": float(arr.mean()),
            "p50_ms": float(np.percentile(arr, 50)),
            "p95_ms": float(np.percentile(arr, 95)),
            "p99_ms": float(np.percentile(arr, 99)),
            "n_runs": int(bench_runs),
        }

    bench_fp32 = _bench(onnx_fp32)
    bench_int8 = _bench(onnx_int8)

    # ---- 7. Compose `export` block + persist
    block = {
        "threshold": threshold,
        "threshold_source": threshold_source,
        "test_source": str(test_source),
        "fp32": {
            "path": str(onnx_fp32),
            "size_mb": round(onnx_fp32.stat().st_size / 1e6, 2),
            "metrics": fp32_metrics,
            "bench": bench_fp32,
        },
        "int8": {
            "path": str(onnx_int8),
            "size_mb": round(onnx_int8.stat().st_size / 1e6, 2),
            "metrics": int8_metrics,
            "bench": bench_int8,
        },
        "drift": {
            "f1": int8_metrics["f1"] - fp32_metrics["f1"],
            "precision": int8_metrics["precision"] - fp32_metrics["precision"],
            "recall": int8_metrics["recall"] - fp32_metrics["recall"],
            "dummy_logit_drift": float(
                abs(out_fp32_dummy[0, 0] - out_int8_dummy[0, 0])
            ),
        },
        "calibration_samples": int(calibration_samples),
        "onnx_opset": int(onnx_opset),
    }

    _patch_results(checkpoint_dir / "results.json", block)

    # ---- 8. W&B (optional)
    wandb_run = tracking.init_run(
        project="smart-turn",
        run_name=f"export-{checkpoint_dir.parent.name}-{checkpoint_dir.name}",
        config={"checkpoint_dir": str(checkpoint_dir)},
        tags=["export", checkpoint_dir.name],
    )
    if wandb_run is not None:
        flat = {
            "export/fp32_test_f1": fp32_metrics["f1"],
            "export/int8_test_f1": int8_metrics["f1"],
            "export/int8_drift_f1": block["drift"]["f1"],
            "export/int8_p50_ms": bench_int8["p50_ms"],
            "export/int8_p95_ms": bench_int8["p95_ms"],
        }
        tracking.log_test_metrics(wandb_run, flat)
    tracking.finish(wandb_run)

    return ExportResult(fp32_onnx=onnx_fp32, int8_onnx=onnx_int8, block=block)


def _patch_results(results_path: Path, block: dict) -> None:
    """Merge the export block into an existing results.json.

    Missing file ⇒ stub a minimal one rather than failing — callers
    sometimes export a checkpoint that pre-dates the results.json
    contract.
    """
    if results_path.exists():
        payload = json.loads(results_path.read_text())
    else:
        payload = {}
    payload["export"] = block
    results_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
