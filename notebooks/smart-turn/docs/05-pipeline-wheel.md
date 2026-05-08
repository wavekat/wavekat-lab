---
name: smart-turn pipeline wheel
description: Design for a non-interactive CLI that runs dataset → train → compare → export end-to-end and tracks results across versions
type: project
---

# 05 — The smart-turn pipeline wheel

**Status:** design. No code yet. Branch `feat/smart-turn-pipeline-wheel`
exists for the doc and the follow-up implementation.

## Why a "wheel"

Today, going from a new export to a comparable model takes ~7 manual
steps across four notebooks:

```
wk exports adapt smart-turn …
└─ open 01_load_export.ipynb,        Run All
   open 02_a_train_baseline.ipynb,   edit EXPORT_DIR / RUN_NAME, Run All
   open 02_b_train_specaugment.ipynb, same edits, Run All
   open 03_compare.ipynb,            edit EXPORT_DIR, Run All, eyeball
   open 04_export.ipynb,             edit RUN_NAME, Run All
```

That works for one-off experiments but it doesn't compose:

- Each new snapshot (`-0501`, `-0502`, `-0503`, …) re-runs the same five
  cells with one variable changed. Pure copy-paste, easy to forget a knob.
- Cross-snapshot comparisons (the exact thing
  [04-0501-0502-models.md](04-0501-0502-models.md) flagged as the
  blocker — "score 0501 ckpt on 0502 test split") aren't a notebook,
  they're an N×M grid. Notebooks don't do grids.
- Results live in a markdown table I edit by hand. Easy to lie to
  myself about which threshold went with which AP.
- No way to ask "what did I change between this run and the one that
  shipped" — the recipe is implicit in the notebook source at the time
  of execution.

The wheel = one command that turns a dataset directory into
`{ checkpoint, threshold.json, results.json, exported ONNX }` and a
ledger entry, deterministic and re-runnable.

## Goal, in one sentence

```
$ wk-st run --dataset datasets/smart-turn-zh-0503 --recipe specaugment
… 12 minutes later …
✅ run smart-turn-zh-0503/specaugment
   val F1 0.918  test F1 0.842 ± 0.029  cont-recall 0.871  AP 0.951
   threshold 0.34   INT8 latency 73 ms / clip
   logged to W&B run pipecat-zh/4f2a   ledger row #19
```

…with no notebook in the loop.

Or, starting one step earlier — straight from a wavekat-platform export
ID, no manual `wk exports …`:

```
$ wk-st run --export-id 7c1e… --recipe specaugment
… downloading export 7c1e… (1842 clips) …
… adapting → datasets/smart-turn-zh-0504/ …
… 12 minutes later …
✅ run smart-turn-zh-0504/specaugment   …
```

Notebooks stay as **tutorial / exploration** surfaces — they're how a
new team member learns the model — but they stop being the way we
ship. The wheel is the way we ship.

## Scope

In:

- A CLI / Python entry point that runs the same pipeline as
  `01 → 02_<recipe> → 03 → 04`, end-to-end, headless.
- A standardized run-output contract (`results.json` schema below).
- A "compare" command that reads N runs and emits the table currently
  in `03_compare.ipynb` — including cross-snapshot eval (every
  checkpoint × every test set).
- A "report" command that regenerates the scorecard table in
  `notebooks/smart-turn/README.md` from the ledger so it stops
  drifting from reality.
- W&B integration, gated behind `WANDB_API_KEY`. Off ⇒ everything
  still works, just no cloud dashboard.
- **Pulling a wavekat-platform export by ID** (download + adapt) so the
  user never runs `wk exports …` by hand. See "Export-ID ingest" below.

Out (deliberately):

- Hyperparameter search. The wheel runs **one** recipe per call. Sweeps
  are a thin loop on top, not a feature of the wheel.
- Distributed / multi-GPU training. T4-on-Azure single-GPU is the
  reference target.
- Creating the export itself (`wk exports create`). That step needs
  project-id + label-keys + split params and is rare enough to stay a
  human-issued command. The wheel picks up from a created export's ID.
- Auto-promoting a checkpoint to "shipped". Picking a winner is still
  a human decision per `MISSION.md`.

## Export-ID ingest

The README's "Producing the input" section is three commands the user
runs by hand:

```
wk exports create <project-id> --name "smart-turn-zh $(date +%Y-%m-%d)" …
wk exports download <export-id> --out ./snapshots/smart-turn-zh
wk exports adapt smart-turn --export-dir ./snapshots/smart-turn-zh \
    --out ./datasets/smart-turn-zh --language zh
```

Step 1 (`create`) stays manual — it's the slow, opinion-laden part.

Steps 2 + 3 (`download` + `adapt`) are mechanical and the wheel does
them. `wk-st run` accepts either a local dataset directory **or** an
export ID:

```
wk-st run --export-id 7c1e2f… --recipe specaugment
                       │
                       └─ resolves to:
                          1. wk exports download <id>
                               --out  snapshots/<derived-name>/
                          2. wk exports adapt smart-turn
                               --export-dir snapshots/<derived-name>/
                               --out        datasets/<derived-name>/
                               --language   zh
                          3. then run --dataset datasets/<derived-name>/ …
```

Behaviour rules:

- **Derived name.** `<derived-name>` defaults to the export's `name`
  field (slugified) — e.g. `smart-turn-zh-2026-05-08` — so the
  directory is human-readable and matches `wk` conventions.
  `--dataset-name <slug>` overrides it (use this for the
  `smart-turn-zh-0504` style we've been using).
- **Idempotent.** If `datasets/<derived-name>/` already exists and its
  recorded export-id matches, skip download + adapt. Re-run cheap.
- **Provenance.** `results.json` (and the ledger row) record both the
  local dataset path **and** the originating export ID, so you can
  always trace a checkpoint back to a platform export.
- **Auth.** Uses whatever `wk` is already configured with. The wheel
  calls `wk` as a subprocess; no separate API client. If `wk` isn't on
  PATH or isn't authed, it fails loudly before any training starts.
- **Two ingest knobs only:** `--export-id` and `--dataset-name`. We
  deliberately do **not** expose `--language`, `--review-status`, or
  `--ratios` here — those are export-creation params and belong in
  `wk exports create`, not in the wheel. (If we ever want them, add a
  `wk-st create-export` thin wrapper later.)

Concretely, this lives in `wkst/ingest.py` and is called once at the
start of `wk-st run` if `--export-id` was passed, before
`wkst.run.train(...)` ever sees the dataset path.

The frozen test set (Gap 1 of doc 04) is the same shape: pass
`--test-export-id <id>` and the wheel downloads + adapts + uses it as
the test source. Or pass `--test datasets/smart-turn-zh-test-frozen`
if it's already on disk.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ tools/smart-turn-pipeline/                                          │
│   src/wkst/                                                         │
│     __main__.py        # `python -m wkst …` / `wk-st …`             │
│     config.py          # Recipe + RunConfig dataclasses             │
│     recipes/           # baseline.py, specaugment.py, … one per     │
│                        # 02_<letter> notebook today                 │
│     ingest.py          # --export-id → wk download + adapt → dataset│
│     run.py             # load → train → eval → write results.json   │
│     compare.py         # NxM grid, cross-snapshot scoring           │
│     report.py          # rebuild README scorecard from ledger       │
│     export.py          # ONNX FP32 + INT8 + drift + bench           │
│     tracking.py        # W&B init / log_metrics / log_artifact      │
│     ledger.py          # checkpoints/_ledger.jsonl writer + reader  │
│   tests/               # unit tests on config, ledger, recipes      │
│   pyproject.toml                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

The heavy lifting (model, dataset, threshold sweep, scoring) **stays**
in `notebooks/smart-turn/smart_turn.py`. The wheel is glue around that
module — `wkst` imports `smart_turn` rather than re-implementing.

This means notebooks and the wheel always run the same code. The
notebooks remain runnable and stay as the readable tutorial surface.

### Recipe = config object, not a notebook

Each `02_<letter>_*.ipynb` collapses to a recipe dict:

```python
# recipes/specaugment.py
RECIPE = Recipe(
    name="specaugment",
    base_model="openai/whisper-tiny",
    epochs=8,
    batch_size=16,
    augment=SpecAugmentCfg(time=(2, 40), freq=(2, 15)),
    seed=42,
)
```

Adding a new variant = a new file in `recipes/`. The notebooks become
optional read-along docs of the same recipe. (Could keep one notebook
per recipe, executing the wheel under the hood — `wkst run --recipe X`
in a single cell — so the tutorial story still holds.)

### Run output contract

Every wheel run writes the same files under
`checkpoints/<dataset>/<recipe>/`:

```
checkpoint-best/                # HF Trainer best-by-F1 checkpoint
threshold.json                  # already exists; sweep result
results.json                    # NEW — single source of truth
run.lock.json                   # NEW — recipe + git sha + dataset hash
training.log
onnx/                           # only if --export passed
```

`results.json` schema:

```json
{
  "run_name": "smart-turn-zh-0503/specaugment",
  "dataset": {
    "path": "datasets/smart-turn-zh-0503",
    "sha256": "…",                  // hash of metadata.json + parquets
    "export_id": "7c1e2f…",          // wavekat-platform export id, if known
    "n_train": 1820, "n_val": 228, "n_test": 224
  },
  "recipe": { "name": "specaugment", "epochs": 8, "...": "..." },
  "git": { "sha": "…", "dirty": false },
  "metrics": {
    "val":  { "f1": 0.918, "p": …, "r": …, "ap": …, "threshold": 0.34 },
    "test": {
      "f1": 0.842, "f1_ci95": [0.813, 0.871],
      "continuation_recall": 0.871,
      "ap": 0.951,
      "per_source": { "wavekat-product": {...}, "ramc": {...} }
    }
  },
  "export": {            // only if --export
    "fp32_test_f1": 0.842, "int8_test_f1": 0.838,
    "int8_drift_f1": -0.004,
    "int8_latency_ms_p50": 73, "int8_latency_ms_p95": 91
  },
  "wandb_run_id": "pipecat-zh/4f2a"
}
```

Bootstrap CIs (the v1 ship-bar metric per `MISSION.md`) move out of
the notebook and into `compute_metrics_with_threshold` once, then
every run gets them for free.

### Ledger

Append-only `checkpoints/_ledger.jsonl`, one line per finished run:

```json
{"ts":"2026-05-08T...","run":"smart-turn-zh-0503/specaugment","results":"checkpoints/smart-turn-zh-0503/specaugment/results.json"}
```

Cheap, gittable (it's just text), and lets `wk-st report` rebuild the
README scorecard on demand. No DB, no service.

### Frozen test set support

Per Gap 1 of [04-0501-0502-models.md](04-0501-0502-models.md), 0503+
ships against a frozen test set, not the test split shipped inside
each snapshot. The wheel takes:

```
--dataset datasets/smart-turn-zh-0503        # used for train+val
--test datasets/smart-turn-zh-test-frozen    # used for test
```

When `--test` is omitted, falls back to the dataset's own test split
(legacy behaviour). All `metrics.test.*` numbers in `results.json` are
labeled with which test set produced them, so cross-version
comparisons stop being silently apples-to-oranges.

## Multi-model / cross-snapshot comparison

```
wk-st compare \
  --runs checkpoints/smart-turn-zh-0501/specaugment \
         checkpoints/smart-turn-zh-0502/specaugment \
         checkpoints/smart-turn-zh-0503/specaugment \
  --tests datasets/smart-turn-zh-0501 \
          datasets/smart-turn-zh-0502 \
          datasets/smart-turn-zh-test-frozen \
  --out reports/0503-cross-eval.md
```

Output: an NxM table of (run × test set) AP / F1 / cont-recall, plus
overlaid PR curves saved to PNG. This is the `03_b_cross_eval.ipynb`
that 04-0501-0502 said we needed, generalized.

`pipecat-v3` zero-shot is always implicitly added as a column so we
keep the frozen-baseline reference visible.

## Should we use W&B?

**Yes, but as a viewer, not as the source of truth.**

Why yes:

- Cross-run PR-curve overlays in a UI beat hand-rolled matplotlib for
  3+ runs, and most of `03_compare.ipynb`'s value is "show me five
  curves on one chart".
- W&B reports = shareable links for cross-version writeups (e.g. the
  04 doc's regression discussion would have been a W&B report instead
  of a long markdown table).
- Already half-wired: `02_a_train_baseline.ipynb` and `02_b_*` both do
  `report_to="wandb" if WANDB_API_KEY`. We just don't log the eval
  metrics, the threshold sweep, or the test-set scoring — so the dash
  is empty of the things we ship on. The wheel can fix that with one
  `tracking.log_metrics(results["metrics"])` call at the end.
- Free for personal / small-team use. No new cost.

Why "viewer, not source of truth":

- Ship decisions need offline-checkable artifacts. `results.json` +
  the ledger live in the repo / checkpoints dir; W&B is best-effort.
- A wheel run with `WANDB_API_KEY` unset must produce identical
  artifacts. No cloud dependency on the critical path.
- W&B model-registry / artifact versioning duplicates what
  `checkpoints/<dataset>/<recipe>/` already gives us. Don't pay twice.

So the rule: log to W&B if the env var is set; never *read* from W&B.
`compare`, `report`, and shipping all go through `results.json`.

Alternatives considered:

- **MLflow** — same shape as W&B, self-hostable, but no clear win for
  a one-person zh-turn project and the UI is rougher.
- **TensorBoard only** — already get it free from HF Trainer. Good for
  loss curves, terrible for cross-run scorecards. Keep it as a
  secondary, not primary.
- **No tracker, just `results.json` + `compare`** — perfectly viable,
  and where we'd land if W&B got annoying. The design supports
  dropping W&B without rework, by construction.

## Phased rollout

Each phase is shippable on its own. Stop after any phase if the next
one isn't paying off.

### Phase 1 — extract recipes, add `wk-st run` (with export-ID ingest)

Goal: replace the `02_<letter>_*` Run-All step **and** the
`wk download` + `wk adapt` hand-typed commands in front of it.

- New `tools/smart-turn-pipeline/` package, deps inherited from the
  `smart-turn` extras group.
- Move `01 + 02_<letter>` cell logic into `wkst.run` (loader,
  trainer, threshold sweep, save). Notebooks stay; they just import
  from `wkst` and become 3-cell wrappers.
- `wkst.ingest` resolves `--export-id` → `wk exports download` +
  `wk exports adapt smart-turn` → dataset directory. Idempotent;
  records the export-id in `results.json`.
- Write `results.json` and append to ledger.
- No W&B yet, no cross-eval yet.

Exit: `wk-st run --export-id <id> --recipe specaugment` produces the
same checkpoint + `threshold.json` as today's manual flow, plus
`results.json` carrying the export-id provenance. `--dataset <path>`
still works for already-adapted snapshots.

### Phase 2 — `wk-st compare` and frozen test set

- `compare` reads any set of `results.json` files and prints the
  table + saves overlaid PR-curve PNGs.
- Add `--test` flag for frozen test set per Gap 1.
- Add bootstrap CIs and continuation-class recall to
  `compute_metrics_with_threshold` so they appear in `results.json`
  for everything, not just new runs.

Exit: 0501 vs 0502 vs 0503 cross-eval table fits in one command and
the AP-regression mystery from 04 is resolved on paper.

### Phase 3 — W&B + `wk-st export` + `wk-st report`

- `tracking.py` wires HF Trainer → W&B (already half-there) and adds
  test-time `log_metrics` + PR-curve `log_table`.
- `wk-st export` runs `04_export.ipynb`'s logic on a chosen run,
  writes the INT8 ONNX + drift + latency block back into
  `results.json`, optionally uploads ONNX as a W&B artifact.
- `wk-st report` rebuilds `notebooks/smart-turn/README.md`'s
  scorecard table from `_ledger.jsonl` so the table stops drifting.

Exit: a new dataset → a comparable, exported, dashboarded model is
three commands. Notebooks become read-only documentation of what each
recipe does, no longer a click-through dependency.

### Phase 4 (maybe) — automation

If by phase 3 we run the wheel ≥1×/week, automate the `0501→0502→…`
cadence:

- A `Makefile` target `wheel-zh DATASET=…` that chains run × N
  recipes + compare + report.
- A GitHub Actions workflow on `workflow_dispatch` that runs the
  same on a self-hosted T4 runner and posts the report as a PR
  comment. (Self-hosted because the wheel needs a GPU to be useful.)

Phase 4 is a "maybe" because it depends on cadence. If we only train
once a month, a local Make target is enough.

## Open questions for implementation

1. **Where does the package live?** Three options:
   - `tools/smart-turn-pipeline/` — own pyproject, own deps, mirrors
     `tools/audio-lab/` and `tools/cv-explorer/`. **Recommended.** It's
     a tool, that's where tools go.
   - `notebooks/smart-turn/_pipeline/` — keeps it adjacent to the
     notebooks but blurs the "tools vs notebooks" line.
   - Put it in the existing `wavekat-cli` repo as `wk smart-turn run …`
     subcommands. Cleanest UX (`wk` is already what we use), but
     pulls torch into wavekat-cli's deps. **Punt** until phase 3.

2. **Notebook fate.** Two viable endings:
   - Keep notebooks as thin `wkst` wrappers (3 cells: import, run,
     show results). Tutorials still work, no duplication.
   - Mark `02_*` / `03` / `04` as deprecated, leave them frozen, point
     readers at the CLI. Cleaner but loses the JupyterLab story.
   - **Lean toward (a)**, decide once phase 1 lands.

3. **What goes into `dataset.sha256`?** Just `metadata.json` + parquet
   file hashes is enough to detect "is this the same export I trained
   on" without re-hashing every audio sample. Confirm by spot-check on
   0501 / 0502 / 0503.

4. **Do we want `wk-st sweep`?** A YAML grid of recipe knobs (learning
   rate, augmentation strength, epochs) → N runs → cross-eval. Could
   be a phase 5 if we ever feel under-resourced on hyperparams. Not
   needed now — the bottleneck is data, not hyperparams.

## Definition of done for the wheel as a whole

- `wk-st run … && wk-st compare … && wk-st export …` reproduces
  every number currently in `notebooks/smart-turn/README.md`'s
  scorecard, end-to-end, from a fresh clone, in one shell session.
- The 0503 model in `04-0501-0502-models.md`'s "Rollup" plan is
  trained, evaluated against the frozen test set, and compared to
  0501 / 0502 / pipecat-v3 — using the wheel, not notebooks.
- The README scorecard is generated by `wk-st report`, not edited by
  hand.
- A new contributor can produce a comparable model from a new export
  in three commands.

## Results

(Empty until phase 1 lands.)
