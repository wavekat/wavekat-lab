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

Organize notebooks by purpose. Suggested folders (create as needed):

- `training/` — model training experiments
- `validation/` — eval runs and metric reporting
- `dataset-splits/` — train/dev/test partitioning logic

The Python env is managed by [uv](https://docs.astral.sh/uv/) via `pyproject.toml` at the repo root.
