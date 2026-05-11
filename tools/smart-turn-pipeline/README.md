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
- `wk-st publish` — stage a checkpoint's INT8 ONNX as
  `<lang>/smart-turn-cpu.onnx` and (with `--upload`) push to
  `wavekat/smart-turn-ONNX` on HuggingFace. Mirrors the wavekat-tts
  publish pattern; each publish touches only its language's subdir
  plus the shared model card. Consumed by [wavekat-turn][wt] (Rust,
  via `hf-hub`) and by Pipecat's own Python loader.

[wt]: https://github.com/wavekat/wavekat-turn

## Install

```sh
# from the wavekat-lab repo root
uv pip install -e tools/smart-turn-pipeline[train]
```

The `train` extra pulls in torch / transformers / datasets — same set
the `notebooks/smart-turn/` extras group already needed. For local
development of the CLI plumbing only (no training), drop `[train]`
and the package installs deps-free.

The lighter `publish` extra (just `huggingface_hub`) is for the
`wk-st publish` flow on a CI runner that doesn't need torch:

```sh
uv pip install -e tools/smart-turn-pipeline[publish]
```

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

### `wk-st publish`

Stage a fine-tuned checkpoint for HuggingFace and, optionally, push
it. Mirrors the wavekat-tts publishing pattern in
[`tools/qwen3-tts-onnx/`](https://github.com/wavekat/wavekat-tts/tree/main/tools/qwen3-tts-onnx).

```sh
# dry-run: stage only, don't touch HuggingFace
wk-st publish \
  --checkpoint checkpoints/smart-turn-zh-0503/specaugment \
  --lang       zh

# upload to wavekat/smart-turn-ONNX (requires HF_TOKEN in env)
HF_TOKEN=hf_xxx wk-st publish \
  --checkpoint checkpoints/smart-turn-zh-0503/specaugment \
  --lang       zh \
  --upload

# pin the upload to a dated revision (kept in sync with wavekat-turn's
# REVISION constant in src/audio/wavekat_download.rs)
HF_TOKEN=hf_xxx wk-st publish \
  --checkpoint checkpoints/smart-turn-zh-0503/specaugment \
  --lang       zh \
  --revision   2026-05-11 \
  --upload
```

The default behaviour is **dry-run**: files are staged under
`<checkpoint>/publish/` (override with `--staging-dir`) and nothing
hits HuggingFace. `--upload` is the explicit opt-in; without it,
`wk-st publish` is safe to script.

Inside the staging dir:

```
<staging>/
├── .gitattributes                   # LFS rules for *.onnx
├── README.md                        # model card, languages table auto-filled
└── <lang>/
    ├── smart-turn-cpu.onnx          # the INT8 ONNX, renamed to match
    │                                  # what wavekat-turn + Pipecat expect
    └── results.json                 # slimmed test metrics (no PR curve,
                                       # no absolute filesystem paths)
```

- The published file name is **`smart-turn-cpu.onnx`** (not
  `smart-turn-int8.onnx`) so wavekat-turn's Rust loader and Pipecat's
  Python loader can both consume it via the same path.
- Each upload touches only `<lang>/` plus the top-level
  `README.md` / `.gitattributes`, so publishing `ja` later won't
  disturb existing `zh` files.
- For a smoke test before any fine-tune exists, override the source
  ONNX with `--onnx <path>` (e.g. point at the upstream Pipecat
  file). The staging step works without a `results.json` — a
  placeholder note is written so the model card still renders.

#### Via GitHub Actions

The `workflow_dispatch` action at
[`.github/workflows/publish-smart-turn.yml`](../../.github/workflows/publish-smart-turn.yml)
wraps the same CLI with `HF_TOKEN` from repo secrets. Inputs match
the CLI flags 1:1 (`checkpoint`, `lang`, `hf_repo`, `revision`,
`onnx_override`, `dry_run`). Job summary links to the resulting
`https://huggingface.co/<repo>/tree/<revision>/<lang>` page on
success.

#### Consumer side

Once `wavekat/smart-turn-ONNX/<lang>/smart-turn-cpu.onnx` is live,
the Rust loader pulls it automatically:

```rust
use wavekat_turn::audio::{PipecatSmartTurn, SmartTurnVariant, SmartTurnLang};

let detector = PipecatSmartTurn::with_variant(
    SmartTurnVariant::Wavekat(SmartTurnLang::Zh),
)?;
```

Requires `wavekat-turn = { features = ["wavekat-smart-turn"] }`. The
`REVISION` constant in `wavekat-turn`'s `src/audio/wavekat_download.rs`
pins which dated upload consumers see — bump it in lockstep with the
crate release when you ship a new checkpoint.

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
  publish.py            # stage <lang>/smart-turn-cpu.onnx + upload to HF
  publish_assets/       # model card template + .gitattributes
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
