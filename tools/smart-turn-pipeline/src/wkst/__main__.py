"""``wk-st`` CLI — phase 1: ``run`` only.

Phase 2 will add ``compare``, phase 3 ``export`` + ``report``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from wkst._paths import checkpoints_dir
from wkst.config import RunConfig
from wkst.recipes import RECIPES, get as get_recipe, names as recipe_names


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="wk-st",
        description=(
            "smart-turn pipeline wheel — turn an export id (or local "
            "dataset) into a trained, threshold-calibrated model with "
            "a results.json artifact."
        ),
    )
    sub = p.add_subparsers(dest="command", required=True)

    run = sub.add_parser(
        "run",
        help="Train a recipe end-to-end on a dataset (phase 1).",
    )

    src = run.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "--export-id",
        help=(
            "wavekat-platform export id. The wheel runs `wk exports "
            "download` + `wk exports adapt smart-turn` for you."
        ),
    )
    src.add_argument(
        "--dataset",
        type=Path,
        help="Path to an already-adapted dataset directory.",
    )

    run.add_argument(
        "--dataset-name",
        help=(
            "Override the on-disk slug (e.g. smart-turn-zh-0504). "
            "Defaults to the export name slugified, or the dataset "
            "directory's leaf name."
        ),
    )

    run.add_argument(
        "--recipe",
        choices=recipe_names(),
        required=True,
        help="Training variant. Add new ones in src/wkst/recipes/.",
    )
    run.add_argument(
        "--run-name",
        help="Leaf dir under checkpoints/<dataset>/. Defaults to the recipe name.",
    )
    run.add_argument(
        "--language",
        default="zh",
        help="Passed through to `wk exports adapt smart-turn --language`.",
    )

    test = run.add_mutually_exclusive_group()
    test.add_argument(
        "--test",
        type=Path,
        help=(
            "Frozen test set directory (must contain test.parquet). "
            "Overrides the dataset's own test split."
        ),
    )
    test.add_argument(
        "--test-export-id",
        help="Like --test, but resolves an export id first.",
    )

    run.add_argument(
        "--warm-start-from",
        type=Path,
        help=(
            "Continue training from a previous checkpoint instead of "
            "the raw Whisper encoder."
        ),
    )

    return p


def _resolve(args: argparse.Namespace) -> RunConfig:
    from wkst.ingest import resolve_dataset

    train_res = resolve_dataset(
        export_id=args.export_id,
        dataset_dir=args.dataset,
        dataset_name=args.dataset_name,
        language=args.language,
    )
    print(
        f"dataset      : {train_res.dataset_dir.name} "
        f"({'cached' if train_res.cached else 'fresh'})"
    )

    test_dir = None
    test_export_id = None
    if args.test is not None:
        test_res = resolve_dataset(dataset_dir=args.test)
        test_dir = test_res.dataset_dir
        print(f"test (override): {test_dir.name}")
    elif args.test_export_id is not None:
        test_res = resolve_dataset(
            export_id=args.test_export_id,
            dataset_name=(args.dataset_name or "") + "-test"
            if args.dataset_name else None,
            language=args.language,
        )
        test_dir = test_res.dataset_dir
        test_export_id = args.test_export_id
        print(f"test (override): {test_dir.name}")

    recipe = get_recipe(args.recipe)
    run_name = args.run_name or recipe.name
    dataset_name = train_res.dataset_name
    checkpoint_dir = checkpoints_dir() / dataset_name / run_name

    return RunConfig(
        recipe=recipe,
        dataset_dir=train_res.dataset_dir,
        checkpoint_dir=checkpoint_dir,
        run_name=run_name,
        dataset_name=dataset_name,
        test_dir=test_dir,
        warm_start_from=args.warm_start_from,
        export_id=train_res.export_id or args.export_id,
        test_export_id=test_export_id,
    )


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "run":
        cfg = _resolve(args)
        print(f"recipe       : {cfg.recipe.name}")
        print(f"checkpoint   : {cfg.checkpoint_dir}")
        # Heavy import only after we know args parse — keeps `wk-st --help`
        # snappy and avoids dragging torch in for unit tests.
        from wkst.run import run as _run

        results_path = _run(cfg)
        print(f"results      : {results_path}")
        return 0

    raise SystemExit(f"unknown command: {args.command}")


if __name__ == "__main__":
    sys.exit(main())
