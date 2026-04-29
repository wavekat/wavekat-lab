# Smart-Turn notebooks

Workflow notebooks for the binary smart-turn (end-of-turn vs continuation)
task, picking up from a `wk exports adapt smart-turn` snapshot.

| File | Purpose |
|---|---|
| `01_load_export.ipynb` | Load Parquet shards, sanity-check splits / label balance / clip durations, audition a few clips. |
| `02_a_train_baseline.ipynb` | Baseline training run — pinned `pos_weight`, F1-best threshold sweep, no augmentation. |
| `02_b_train_specaugment.ipynb` | Variant: + SpecAugment (time/freq masking on train mels). |
| `02_<letter>_*.ipynb` | Add a new letter per experiment; thin notebook = config + run, all heavy code lives in `smart_turn.py`. |
| `03_eval.ipynb` | Held-out metrics on `ds["test"]`, ONNX FP32 export, INT8 static quantization, FP32-vs-INT8 latency benchmark. Set `RUN_NAME` to pick which `02_<letter>_*` checkpoint to evaluate. |
| `smart_turn.py` | Shared module: `SmartTurnModel`, `SmartTurnDataset`, `spec_augment`, `compute_metrics_with_threshold`, `evaluate_and_save_threshold`, etc. The `02_*` notebooks import from here so they stay thin and the model definition lives in one place. |

Each `02_<letter>_*` run writes to its own subdir under
`checkpoints/<dataset>/<run>/` (e.g. `checkpoints/smart-turn-zh/baseline/`)
along with a `threshold.json`. `03_eval.ipynb` reads that subdir based on
the `RUN_NAME` you pick.

## Producing the input

Use [`wavekat-cli`](https://github.com/wavekat/wavekat-cli):

```sh
wk exports create <project-id> \
  --name "smart-turn-zh $(date +%Y-%m-%d)" \
  --review-status approved \
  --label-key end_of_turn \
  --label-key continuation \
  --split random --seed 42 --ratios 0.8,0.1,0.1

wk exports download <export-id> --out ./snapshots/smart-turn-zh
wk exports adapt smart-turn \
  --export-dir ./snapshots/smart-turn-zh \
  --out ./datasets/smart-turn-zh \
  --language zh
```

The notebooks default to `../../datasets/smart-turn-zh` relative to
this directory — override `EXPORT_DIR` in the first code cell if your
output landed elsewhere.

## Install heavy deps

`02_train.ipynb` and `03_eval.ipynb` need PyTorch, transformers, and
ONNX Runtime. These aren't in the lab's base env (the loader notebook
doesn't need them) — install them via the `smart-turn` extras group
**before** launching JupyterLab:

```sh
uv sync --extra smart-turn
# or:  pip install -e ".[smart-turn]"
```

Then start the kernel as usual (`uv run jupyter lab`) and Run-All
should work end-to-end.

## Training environment

`02_train.ipynb` needs a GPU to be practical. The reference recipe
(Azure NC4as_T4_v3, Tesla T4 16 GB, Docker + nvidia-container-toolkit,
`whisper-tiny` encoder fine-tune) lives upstream at
[pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn) and
in the team's GPU-VM playbook — these notebooks adopt the same model
architecture and quantization pipeline so artifacts are wire-compatible
with pipecat consumers.

Hyperparameters in `02_train.ipynb` are tuned for ~1k-sample exports
(batch 16, 8 epochs, eval per epoch). For the upstream-scale 270k
dataset, raise the batch size and drop epochs back to upstream defaults.

`03_eval.ipynb` writes ONNX artifacts into
`../../checkpoints/smart-turn-zh/onnx/`; the INT8 file is what plugs
into pipecat's `SmartTurnAnalyzer` for on-device end-of-turn detection.

## Experiments

Tracking what we've tried on the `smart-turn-zh` snapshot
(1062 train / 59 val / 59 test). Caveat: with a 59-sample val/test set
a single-sample flip ≈ 1.7pt F1, so deltas under ~3pt are within noise.

**Val F1** = best threshold-swept F1 on `ds["validation"]` (used to
pick the epoch). **Test F1** = held-out F1 from `03_eval.ipynb` on
`ds["test"]` at the same shipped threshold — that's what actually
ships. Always paste both.

| # | RUN_NAME | Notebook | Threshold | Val F1 | Val P / R | Test F1 (FP32 / INT8) | Notes |
|---|---|---|---|---|---|---|---|
| 1 | _legacy_ | pre-refactor `02_train.ipynb`, per-batch pos_weight, fixed thr=0.5 | 0.50 | 0.8125 (ep 8) | 0.788 / 0.839 | _not recorded_ | First reference run. Removed by the smart_turn.py refactor. |
| 2 | _legacy_ | pre-refactor `02_train.ipynb`, + threshold sweep + pinned pos_weight | 0.41 (swept) | 0.7826 (ep 5) | 0.711 / 0.871 | _not recorded_ | PR-curve AP=0.768. F1 vs run 1 is within val noise; the win is the calibrated operating point. |
| 3 | `baseline` | `02_a_train_baseline.ipynb` | _tbd_ | _not yet run_ | — | — | Refactored thin notebook; conceptually equivalent to run 2. |
| 4 | `specaugment` | `02_b_train_specaugment.ipynb` | _tbd_ | _not yet run_ | — | — | + SpecAugment time 2×40, freq 2×15. Expect F1-vs-threshold plateau to widen; may need `EPOCHS=12`. |

What's been won so far independent of val noise:

- **Calibrated operating threshold** — `02_train.ipynb` writes
  `threshold.json` next to the checkpoint; `03_eval.ipynb` loads it for
  both PyTorch and INT8 metrics. +3.6pt F1 over `> 0.5` on the same
  probabilities, so this is a free win at inference time.
- **Stable pos_weight** — pinned once from the full train label
  distribution. Avoids the pathological case where a small batch with
  zero positives clamped the BCE weight to its ceiling.
- **F1-driven early stop** — `Trainer(metric_for_best_model="f1",
  load_best_model_at_end=True)` already in place; the best epoch by F1
  is what gets saved.

Add a row when you run a new experiment.
