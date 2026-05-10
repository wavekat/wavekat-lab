"""``wk-st`` CLI — ``run``, ``compare``, ``export``, ``report``."""

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

    # ── compare ────────────────────────────────────────────────────────────
    cmp_ = sub.add_parser(
        "compare",
        help=(
            "Read mode: print metrics from each run's results.json. "
            "Cross-eval mode: also score every run on every --tests "
            "dataset (needs torch + the checkpoints on disk)."
        ),
    )
    cmp_.add_argument(
        "--runs",
        nargs="+",
        required=True,
        type=Path,
        help="Checkpoint directories (each must have results.json).",
    )
    cmp_.add_argument(
        "--tests",
        nargs="*",
        type=Path,
        help=(
            "If set, switch to cross-eval mode: score every run on "
            "every dataset directory listed here. Each must contain a "
            "test.parquet."
        ),
    )
    cmp_.add_argument(
        "--pipecat-onnx",
        type=Path,
        help=(
            "Optional pipecat-ai/smart-turn-v3 ONNX path; adds it as a "
            "frozen baseline column in cross-eval mode."
        ),
    )
    cmp_.add_argument(
        "--out",
        type=Path,
        help=(
            "Write the markdown table to this file (and a .json sibling). "
            "Without --out, prints to stdout."
        ),
    )
    cmp_.add_argument(
        "--metric",
        default="f1",
        choices=["f1", "ap", "continuation_recall", "precision", "recall"],
        help="Which metric drives the cross-eval grid (default: f1).",
    )
    cmp_.add_argument(
        "--bootstrap-n",
        type=int,
        default=1000,
        help="Bootstrap resamples for F1 CIs in cross-eval mode.",
    )

    # ── export ─────────────────────────────────────────────────────────────
    exp = sub.add_parser(
        "export",
        help=(
            "ONNX FP32 + INT8 quantize + drift + bench on a chosen "
            "checkpoint. Patches the run's results.json with an "
            "`export` block."
        ),
    )
    exp.add_argument(
        "--checkpoint",
        type=Path,
        required=True,
        help="Checkpoint directory produced by `wk-st run`.",
    )
    exp.add_argument(
        "--dataset",
        type=Path,
        required=True,
        help=(
            "Dataset directory with train.parquet (used as INT8 "
            "calibration source) and, by default, the test set."
        ),
    )
    exp.add_argument(
        "--test",
        type=Path,
        help=(
            "Override the test set (must contain test.parquet). "
            "Useful for the frozen-test workflow."
        ),
    )
    exp.add_argument(
        "--calibration-samples",
        type=int,
        default=256,
        help="How many train clips to feed the entropy calibrator.",
    )
    exp.add_argument(
        "--bench-runs",
        type=int,
        default=100,
        help="ONNX latency-bench iterations after warmup.",
    )

    # ── re-eval ────────────────────────────────────────────────────────────
    rev = sub.add_parser(
        "re-eval",
        help=(
            "Re-score val (+ test) on a saved checkpoint and patch "
            "metrics.{val,test}.pr_curve into the run's results.json. "
            "Back-fill path for runs that pre-date commit e20f7a0."
        ),
    )
    rev.add_argument(
        "--checkpoint",
        type=Path,
        required=True,
        help="Checkpoint directory produced by `wk-st run`.",
    )
    rev.add_argument(
        "--dataset",
        type=Path,
        required=True,
        help=(
            "Dataset directory with validation.parquet (and optionally "
            "test.parquet — used as the test set unless --test is given)."
        ),
    )
    rev.add_argument(
        "--test",
        type=Path,
        help=(
            "Override the test set (must contain test.parquet). Useful "
            "for the frozen-test workflow."
        ),
    )
    rev.add_argument(
        "--batch-size",
        type=int,
        default=16,
        help="Inference batch size (default 16).",
    )

    # ── report ─────────────────────────────────────────────────────────────
    rep = sub.add_parser(
        "report",
        help=(
            "Rebuild the README scorecard from checkpoints/_ledger.jsonl. "
            "Markers `<!-- wk-st:scorecard:start -->` / "
            "`<!-- wk-st:scorecard:end -->` must surround the table."
        ),
    )
    rep.add_argument(
        "--readme",
        type=Path,
        help=(
            "Path to the README to patch. Defaults to "
            "notebooks/smart-turn/README.md."
        ),
    )
    rep.add_argument(
        "--print",
        dest="print_only",
        action="store_true",
        help="Print the table to stdout without touching the README.",
    )

    return p


def _resolve(args: argparse.Namespace) -> RunConfig:
    from wkst.ingest import resolve_dataset

    if args.export_id is not None:
        print(f"resolving    : export {args.export_id}", flush=True)
    else:
        print(f"resolving    : dataset {args.dataset}", flush=True)

    train_res = resolve_dataset(
        export_id=args.export_id,
        dataset_dir=args.dataset,
        dataset_name=args.dataset_name,
        language=args.language,
    )
    print(
        f"dataset      : {train_res.dataset_dir.name} "
        f"({'cached' if train_res.cached else 'fresh'})",
        flush=True,
    )

    test_dir = None
    test_export_id = None
    if args.test is not None:
        test_res = resolve_dataset(dataset_dir=args.test)
        test_dir = test_res.dataset_dir
        print(f"test (override): {test_dir.name}", flush=True)
    elif args.test_export_id is not None:
        print(f"resolving    : test export {args.test_export_id}", flush=True)
        test_res = resolve_dataset(
            export_id=args.test_export_id,
            dataset_name=(args.dataset_name or "") + "-test"
            if args.dataset_name else None,
            language=args.language,
        )
        test_dir = test_res.dataset_dir
        test_export_id = args.test_export_id
        print(f"test (override): {test_dir.name}", flush=True)

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

    if args.command == "compare":
        return _compare(args)

    if args.command == "export":
        from wkst.export import export_run

        result = export_run(
            checkpoint_dir=args.checkpoint,
            dataset_dir=args.dataset,
            test_dir=args.test,
            calibration_samples=args.calibration_samples,
            bench_runs=args.bench_runs,
        )
        print(f"FP32 ONNX : {result.fp32_onnx}")
        print(f"INT8 ONNX : {result.int8_onnx}")
        b = result.block
        print(
            f"INT8 test : F1 {b['int8']['metrics']['f1']:.3f}  "
            f"(Δ {b['drift']['f1']:+.3f} vs FP32)"
        )
        print(
            f"INT8 lat  : p50 {b['int8']['bench']['p50_ms']:.1f} ms  "
            f"p95 {b['int8']['bench']['p95_ms']:.1f} ms"
        )
        return 0

    if args.command == "re-eval":
        from wkst.reeval import reeval

        result = reeval(
            checkpoint_dir=args.checkpoint,
            dataset_dir=args.dataset,
            test_dir=args.test,
            batch_size=args.batch_size,
        )
        print(f"results      : {result.results_path}")
        print(f"val pr_curve : {result.val_curve_n} points")
        print(
            f"test pr_curve: "
            f"{result.test_curve_n} points"
            + (" (no test.parquet found — skipped)" if result.test_curve_n == 0 else "")
        )
        return 0

    if args.command == "report":
        from wkst import report

        if args.print_only:
            rows = report.collect_rows()
            print(report.render_scorecard(rows))
            return 0
        updated = report.rebuild_readme(args.readme)
        print("README updated" if updated else "README unchanged")
        return 0

    raise SystemExit(f"unknown command: {args.command}")


def _compare(args) -> int:
    """Implement the ``compare`` subcommand. Read or cross-eval mode."""
    from wkst import compare as cmp_

    cards = cmp_.load_run_cards(args.runs)

    if args.tests:
        grid = cmp_.cross_eval(
            checkpoint_dirs=[c.checkpoint_dir for c in cards],
            test_dirs=args.tests,
            pipecat_onnx=args.pipecat_onnx,
            bootstrap_n=args.bootstrap_n,
        )
        table = cmp_.render_cross_eval_table(grid, metric=args.metric)
        body = (
            f"# wk-st compare — cross-eval ({args.metric})\n\n"
            f"{table}\n\n"
            f"_runs={len(grid['runs'])} tests={len(grid['tests'])} "
            f"metric={args.metric}_\n"
        )
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(body)
            args.out.with_suffix(args.out.suffix + ".json").write_text(
                __import__("json").dumps(grid, indent=2, ensure_ascii=False)
            )
            print(f"wrote {args.out}")
        else:
            print(body)
        return 0

    table = cmp_.render_read_table(cards)
    body = f"# wk-st compare — read mode\n\n{table}\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(body)
        print(f"wrote {args.out}")
    else:
        print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
