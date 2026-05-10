# smart-turn-pipeline (`wk-st`)

Non-interactive CLI for the smart-turn workflow that lives in
[`notebooks/smart-turn/`](../../notebooks/smart-turn/). Replaces
clicking through `01 → 02 → 03 → 04` notebooks with one command.

Design doc:
[`notebooks/smart-turn/docs/05-pipeline-wheel.md`](../../notebooks/smart-turn/docs/05-pipeline-wheel.md).

## Status

Phases 1, 2, and 3 landed — the wheel is feature-complete per the
design doc:

- `wk-st run` — ingest a wavekat-platform export id (or use a local
  adapted dataset) and train one recipe end-to-end, producing the
  same checkpoint + `threshold.json` the notebooks produce, plus a
  structured `results.json` and a ledger entry. Test metrics include
  **bootstrap 95% F1 CI** and **continuation-class recall** (the
  actual `MISSION.md` ship metrics). W&B test-time logging if
  `WANDB_API_KEY` is set.
- `wk-st compare` — read mode (just prints metrics from each run's
  `results.json`) and cross-eval mode (`--tests`: score every run on
  every dataset, the NxM grid that doc 04 said was the blocker for
  resolving the 0501 → 0502 AP regression). `--pipecat-onnx`
  optionally adds the pipecat-v3 frozen-baseline column.
- `wk-st export` — FP32 ONNX export, INT8 static quantization (QDQ +
  entropy calibration), FP32-vs-INT8 drift on the test set, and CPU
  latency benchmark (p50/p95/p99). Patches the run's `results.json`
  with an `export` block.
- `wk-st eval-pipecat` — score a frozen pipecat-v3 ONNX on a test
  set and write a `results.json` (with **PR curve**) into
  `checkpoints/<dataset>/<run-name>/`. No training, no val pass —
  pipecat shows up as a first-class row in the ledger / scorecard
  alongside trained recipes, and `wk-st compare --runs` can include
  it directly.
- `wk-st report` — regenerates the README scorecard from the ledger.
  Looks for `<!-- wk-st:scorecard:start -->` /
  `<!-- wk-st:scorecard:end -->` markers and rewrites just the
  region between them, leaving the historical / hand-curated section
  alone.

## Install

```sh
# from the wavekat-lab repo root
uv pip install -e tools/smart-turn-pipeline[train]
```

The `train` extra pulls in torch / transformers / datasets — same set
the `notebooks/smart-turn/` extras group already needed. For local
development of the CLI plumbing only (no training), drop `[train]`
and the package installs deps-free.

## Usage

### `wk-st run`

```sh
# from a wavekat-platform export id — the wheel does download + adapt
wk-st run --export-id 7c1e2f3a --recipe specaugment

# or from an already-adapted dataset directory
wk-st run --dataset datasets/smart-turn-zh-0503 --recipe baseline

# with a frozen test set (per docs/04 Gap 1)
wk-st run --export-id 7c1e2f3a --recipe specaugment \
          --test datasets/smart-turn-zh-test-frozen

# warm-start from a previous checkpoint
wk-st run --dataset datasets/smart-turn-zh-0503 --recipe specaugment \
          --warm-start-from checkpoints/smart-turn-zh-0502/specaugment
```

### `wk-st compare`

```sh
# read mode — just print recorded test metrics, no torch needed
wk-st compare --runs \
  checkpoints/smart-turn-zh-0501/specaugment \
  checkpoints/smart-turn-zh-0502/specaugment \
  checkpoints/smart-turn-zh-0503/specaugment

# cross-eval — every run × every test set; resolves the 0501→0502
# regression by scoring each ckpt on every test split.
wk-st compare \
  --runs   checkpoints/smart-turn-zh-0501/specaugment \
           checkpoints/smart-turn-zh-0502/specaugment \
           checkpoints/smart-turn-zh-0503/specaugment \
  --tests  datasets/smart-turn-zh-0501 \
           datasets/smart-turn-zh-0502 \
           datasets/smart-turn-zh-test-frozen \
  --pipecat-onnx checkpoints/pipecat/smart-turn-v3.onnx \
  --metric f1 \
  --out    reports/0503-cross-eval.md
```

### `wk-st export`

```sh
wk-st export \
  --checkpoint checkpoints/smart-turn-zh-0503/specaugment \
  --dataset    datasets/smart-turn-zh-0503
```

Produces `checkpoint_dir/onnx/smart-turn.onnx` (FP32) and
`smart-turn-int8.onnx` (INT8 QDQ), scores both on the test set at
the run's saved threshold, runs a CPU latency bench, and merges an
`export` block into `results.json`.

### `wk-st eval-pipecat`

```sh
# from a wavekat-platform export id — wheel does download + adapt
wk-st eval-pipecat \
  --pipecat-onnx checkpoints/pipecat/smart-turn-v3.onnx \
  --test-export-id 7f862add-25a1-40d8-8fc0-fb4a2d4d5500

# or from an already-adapted dataset directory
wk-st eval-pipecat \
  --pipecat-onnx checkpoints/pipecat/smart-turn-v3.onnx \
  --test datasets/smart-turn-zh-test-frozen \
  --run-name pipecat-v3.2-cpu
```

Writes `checkpoints/<dataset>/<run-name>/results.json` with a full
`metrics.test` block (F1, F1 CI95, AP, continuation-recall, **PR
curve points**) and appends to `_ledger.jsonl`. Threshold defaults
to 0.5 (pipecat-v3 ships at that operating point); override with
`--threshold`.

### `wk-st report`

```sh
# rewrite notebooks/smart-turn/README.md between the markers
wk-st report

# preview without writing
wk-st report --print
```

Markers in the README:

```markdown
<!-- wk-st:scorecard:start -->
<!-- wk-st:scorecard:end -->
```

If the markers are missing, `wk-st report` prints a hint and exits
without touching the file.

Outputs land in `checkpoints/<dataset-name>/<run-name>/`:

```
checkpoint-best/                # HF Trainer best-by-F1
threshold.json                  # operating threshold
results.json                    # run-output contract
run.lock.json                   # recipe + git sha + dataset hash
```

…plus a one-line append to `checkpoints/_ledger.jsonl`.

## Tests

```sh
cd tools/smart-turn-pipeline
uv run pytest                   # unit tests; no GPU / no torch needed
```

The unit tests cover config serialisation, recipe registration, the
ledger, the path resolver, the CLI argument parser, and ingest's
subprocess plumbing (mocked). Training itself is exercised by hand
against a real dataset on a GPU box.

## Layout

```
src/wkst/
  __main__.py           # `wk-st …` argparse entry
  config.py             # Recipe + RunConfig + SpecAugmentCfg dataclasses
  recipes/              # baseline.py, specaugment.py — registry
  ingest.py             # --export-id → wk download + adapt → dataset dir
  run.py                # load → train → eval → results.json
  metrics.py            # bootstrap F1 CI, continuation-class recall
  compare.py            # read mode + NxM cross-eval grid
  export.py             # FP32 + INT8 ONNX, drift, CPU latency bench
  eval_pipecat.py       # score a pipecat-v3 ONNX, emit run-shaped results.json
  report.py             # ledger → README scorecard regeneration
  tracking.py           # optional W&B integration (off by default)
  ledger.py             # checkpoints/_ledger.jsonl reader/writer
  _paths.py             # repo-root / datasets / checkpoints resolution
  _smart_turn.py        # sys.path shim for notebooks/smart-turn/smart_turn.py
tests/                  # fast unit tests, no torch
```

The `notebooks/smart-turn/smart_turn.py` module is the single
implementation of the model + dataset + threshold logic; the CLI
imports it via the sys.path shim. Notebooks and CLI run identical
code — change `smart_turn.py`, both surfaces pick it up.
