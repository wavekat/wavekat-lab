# Smart-Turn notebooks

Workflow notebooks for the binary smart-turn (end-of-turn vs continuation)
task, picking up from a `wk exports adapt smart-turn` snapshot.

> Mission, improvement plan, and per-experiment writeups live in
> [`docs/`](docs/). This README stays focused on the runnable workflow
> and the at-a-glance scorecard; long-form research notes go in `docs/`.

| File | Purpose |
|---|---|
| `01_load_export.ipynb` | Load Parquet shards, sanity-check splits / label balance / clip durations, audition a few clips. |
| `02_a_train_baseline.ipynb` | Baseline training run — pinned `pos_weight`, F1-best threshold sweep, no augmentation. |
| `02_b_train_specaugment.ipynb` | Variant: + SpecAugment (time/freq masking on train mels). |
| `02_<letter>_*.ipynb` | Add a new letter per experiment; thin notebook = config + run, all heavy code lives in `smart_turn.py`. |
| `03_compare.ipynb` | Eval step. Score every `02_<letter>_*` checkpoint on `ds["test"]` at its shipped threshold, plus the upstream `pipecat-ai/smart-turn-v3` ONNX as the zero-shot floor. Emits a side-by-side metrics table + overlaid PR curves so you can pick a winner. |
| `04_export.ipynb` | Export step — only run after picking a winner in `03_compare`. ONNX FP32 export, INT8 static quantization, FP32-vs-INT8 drift on test, CPU latency benchmark. |
| `smart_turn.py` | Shared module: `SmartTurnModel`, `SmartTurnDataset`, `spec_augment`, `compute_metrics_with_threshold`, `evaluate_and_save_threshold`, `score_run`, `score_onnx`, etc. The `02_*` / `03_*` / `04_*` notebooks import from here so they stay thin and the model definition lives in one place. |

Each `02_<letter>_*` run writes to its own subdir under
`checkpoints/<dataset>/<run>/` (e.g. `checkpoints/smart-turn-zh/baseline/`)
along with a `threshold.json`. `03_compare` reads them all in one pass;
`04_export` reads just the winner you point `RUN_NAME` at.

The full flow:

```
01_load_export.ipynb       (once per snapshot)
   ↓
02_a / 02_b / 02_c / ...   (one notebook per training variant)
   ↓
03_compare.ipynb           (eval all variants on ds["test"], pick a winner)
   ↓
04_export.ipynb            (ship the winner: ONNX + INT8 + bench)
```

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

The `02_*` / `03_compare.ipynb` / `04_export.ipynb` notebooks need
PyTorch, transformers, and ONNX Runtime. These aren't in the lab's
base env (the loader notebook doesn't need them) — install them via
the `smart-turn` extras group **before** launching JupyterLab:

```sh
uv sync --extra smart-turn
# or:  pip install -e ".[smart-turn]"
```

Then start the kernel as usual (`uv run jupyter lab`) and Run-All
should work end-to-end.

## Training environment

The `02_<letter>_*.ipynb` training notebooks need a GPU to be
practical. The reference recipe (Azure NC4as_T4_v3, Tesla T4 16 GB,
Docker + nvidia-container-toolkit, `whisper-tiny` encoder fine-tune)
lives upstream at
[pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn) and
in the team's GPU-VM playbook — these notebooks adopt the same model
architecture and quantization pipeline so artifacts are wire-compatible
with pipecat consumers.

Hyperparameters in `02_a_train_baseline.ipynb` are tuned for ~1k-sample
exports (batch 16, 8 epochs, eval per epoch). For the upstream-scale
270k dataset, raise the batch size and drop epochs back to upstream
defaults.

`04_export.ipynb` writes ONNX artifacts into
`../../checkpoints/<dataset>/<run>/onnx/`; the INT8 file is what plugs
into pipecat's `SmartTurnAnalyzer` for on-device end-of-turn detection.

## Experiments

Tracking what we've tried across snapshots. Each `smart-turn-zh-*`
dataset is a separate `wk exports adapt smart-turn` snapshot under
`datasets/`; the suffix is the date the export was cut.

| Snapshot | Train | Val | Test | Total | Source |
|---|---|---|---|---|---|
| `smart-turn-zh` (legacy) | 1062 | 59 | 59 | 1180 | initial wavekat human labels |
| `smart-turn-zh-0501` | 1256 | 155 | 158 | 1569 | wavekat human labels |
| `smart-turn-zh-0502` | 1470 | 185 | 181 | 1836 | 0501 + RAMC uncertainty-mined clips, hand-confirmed |

**Important caveat for cross-snapshot comparisons:** the test split is
re-drawn each export, so AP/F1 numbers on different snapshots are not
apples-to-apples. The 0502 test set in particular is harder than
0501's — pipecat-v3 (a frozen baseline) lost 3pt AP between them. See
[`docs/04-0501-0502-models.md`](docs/04-0501-0502-models.md) for the
full discussion and the plan to freeze a single test set going
forward.

Caveat for the original 59-sample val/test set: a single-sample flip
≈ 1.7pt F1, so deltas under ~3pt are within noise.

**Val F1** = best threshold-swept F1 on `ds["validation"]` (used to
pick the epoch). **Test F1** = held-out F1 from `03_compare.ipynb` on
`ds["test"]` at the same shipped threshold — that's what actually
ships. INT8 column comes from `04_export.ipynb` (only the winner gets
exported). Always paste both.

| # | RUN_NAME | Notebook | Threshold | Val F1 | Val P / R | Test F1 (FP32 / INT8) | Notes |
|---|---|---|---|---|---|---|---|
| 1 | _legacy_ | pre-refactor `02_train.ipynb`, per-batch pos_weight, fixed thr=0.5 | 0.50 | 0.8125 (ep 8) | 0.788 / 0.839 | _not recorded_ | First reference run. Removed by the smart_turn.py refactor. |
| 2 | _legacy_ | pre-refactor `02_train.ipynb`, + threshold sweep + pinned pos_weight | 0.41 (swept) | 0.7826 (ep 5) | 0.711 / 0.871 | _not recorded_ | PR-curve AP=0.768. F1 vs run 1 is within val noise; the win is the calibrated operating point. |
| 3 | `baseline` | `02_a_train_baseline.ipynb` | 0.38 (swept) | _see compare_ | — | 0.643 / _not exported_ | Refactored thin notebook, conceptually equivalent to run 2. Test AP=0.702. |
| 4 | `specaugment` | `02_b_train_specaugment.ipynb` | 0.44 (swept) | _see compare_ | — | **0.691** / _tbd_ | + SpecAugment time 2×40, freq 2×15. Test AP=0.722. **Winner** — beats baseline on F1 (+4.8pt), precision, recall, AP. Export this. |
| 5 | `0501/baseline` | `02_a_train_baseline.ipynb` on `smart-turn-zh-0501` | 0.09 (swept) | 0.909 | — | _tbd_ | Test AP=0.959. First run on the larger 0501 snapshot. |
| 6 | `0501/specaugment` | `02_b_train_specaugment.ipynb` on `smart-turn-zh-0501` | 0.71 (swept) | 0.912 | — | _tbd_ | Test AP=**0.990**. Best AP we've recorded — but on the 0501 test split only. |
| 7 | `0502/baseline` | `02_a_train_baseline.ipynb` on `smart-turn-zh-0502` | 0.60 (swept) | 0.929 | — | _tbd_ | Test AP=0.935 on 0502 test split. |
| 8 | `0502/specaugment` | `02_b_train_specaugment.ipynb` on `smart-turn-zh-0502` | 0.21 (swept) | 0.910 | — | _tbd_ | Test AP=0.909 on 0502 test split. **AP looks lower than #6 but the test set is harder** — pipecat-v3 also lost 3pt on the same split (see `docs/04-0501-0502-models.md`). |

What's been won so far independent of val noise:

- **Calibrated operating threshold** — every `02_<letter>_*` writes
  `threshold.json` next to the checkpoint; `03_compare` and `04_export`
  load it so PyTorch / FP32 ONNX / INT8 ONNX metrics all use the same
  shipped operating point. +3.6pt F1 over `> 0.5` on the same
  probabilities, so this is a free win at inference time.
- **Stable pos_weight** — pinned once from the full train label
  distribution. Avoids the pathological case where a small batch with
  zero positives clamped the BCE weight to its ceiling.
- **F1-driven early stop** — `Trainer(metric_for_best_model="f1",
  load_best_model_at_end=True)` already in place; the best epoch by F1
  is what gets saved.

Add a row when you run a new experiment.
