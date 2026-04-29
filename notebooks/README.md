# Notebooks

Jupyter notebooks for training, validation, and dataset-splitting workflows.

## Setup

```bash
make setup-notebooks   # or: uv sync   (from repo root)
```

## Running

```bash
make lab               # or: uv run jupyter lab notebooks/   (from repo root)
```

## Layout

Organize notebooks by purpose. Existing and suggested folders:

- `smart-turn/` — load + train + eval the binary smart-turn task from a `wk exports adapt smart-turn` snapshot. See [`smart-turn/README.md`](smart-turn/README.md).
- `training/` — model training experiments
- `validation/` — eval runs and metric reporting
- `dataset-splits/` — train/dev/test partitioning logic

The Python env is managed by [uv](https://docs.astral.sh/uv/) via `pyproject.toml` at the repo root.
