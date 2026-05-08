# smart-turn-pipeline (`wk-st`)

Non-interactive CLI for the smart-turn workflow that lives in
[`notebooks/smart-turn/`](../../notebooks/smart-turn/). Replaces
clicking through `01 → 02 → 03 → 04` notebooks with one command.

Design doc:
[`notebooks/smart-turn/docs/05-pipeline-wheel.md`](../../notebooks/smart-turn/docs/05-pipeline-wheel.md).

## Status

Phase 1 (this commit): `wk-st run` — ingest a wavekat-platform export
id (or use a local adapted dataset) and train one recipe end-to-end,
producing the same checkpoint + `threshold.json` the notebooks
produce, plus a structured `results.json` and a ledger entry.

Phase 2 will add `wk-st compare`. Phase 3 adds `wk-st export` +
`wk-st report` + W&B logging. See the design doc for what each phase
is on the hook for.

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
  ledger.py             # checkpoints/_ledger.jsonl reader/writer
  _paths.py             # repo-root / datasets / checkpoints resolution
  _smart_turn.py        # sys.path shim for notebooks/smart-turn/smart_turn.py
tests/                  # fast unit tests, no torch
```

The `notebooks/smart-turn/smart_turn.py` module is the single
implementation of the model + dataset + threshold logic; the CLI
imports it via the sys.path shim. Notebooks and CLI run identical
code — change `smart_turn.py`, both surfaces pick it up.
