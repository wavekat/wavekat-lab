"""``wk-st report`` — rebuild the README scorecard from the ledger.

The notebook-level ``notebooks/smart-turn/README.md`` carries an
"Experiments" scorecard table that today is hand-edited every time a
new run lands. That drifts the moment somebody forgets, and the doc
04 incident is partly about exactly that.

This module reads ``checkpoints/_ledger.jsonl`` + every referenced
``results.json``, produces a fresh markdown table, and patches it
into the README between two HTML comment markers:

    <!-- wk-st:scorecard:start -->
    <!-- wk-st:scorecard:end -->

If the markers are missing, ``rebuild_readme`` is a no-op and prints
a hint — we never invent a section in the wrong place.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from wkst import ledger
from wkst._paths import checkpoints_dir, smart_turn_module_dir

START_MARKER = "<!-- wk-st:scorecard:start -->"
END_MARKER = "<!-- wk-st:scorecard:end -->"


@dataclass(frozen=True)
class ScorecardRow:
    """One run's view in the README. Sourced from results.json."""

    run: str
    dataset: str
    recipe: str
    n_train: int
    n_val: int
    n_test: int
    val_f1: float | None
    val_threshold: float | None
    test_f1: float | None
    test_f1_ci: tuple[float, float] | None
    test_continuation_recall: float | None
    test_ap: float | None
    test_n: int | None
    test_source: str | None

    @classmethod
    def from_results(cls, results: dict) -> "ScorecardRow":
        run_name = results.get("run_name") or ""
        if "/" in run_name:
            dataset, recipe = run_name.split("/", 1)
        else:
            dataset, recipe = "", run_name
        ds = results.get("dataset") or {}
        m = results.get("metrics") or {}
        val = m.get("val") or {}
        test = m.get("test") or {}
        ci = test.get("f1_ci95") or []
        return cls(
            run=run_name,
            dataset=dataset,
            recipe=recipe,
            n_train=int(ds.get("n_train") or 0),
            n_val=int(ds.get("n_val") or 0),
            n_test=int(ds.get("n_test") or 0),
            val_f1=val.get("f1"),
            val_threshold=val.get("threshold"),
            test_f1=test.get("f1"),
            test_f1_ci=(float(ci[0]), float(ci[1])) if len(ci) == 2 else None,
            test_continuation_recall=test.get("continuation_recall"),
            test_ap=test.get("ap"),
            test_n=test.get("n"),
            test_source=test.get("source"),
        )


def collect_rows(*, root: Path | None = None) -> list[ScorecardRow]:
    """Load every ledger entry and resolve its ``results.json``.

    Entries whose results file is missing are skipped (training was
    deleted but the ledger line stayed) — we don't want a stale
    pointer to wedge the whole report.
    """
    base = (root or checkpoints_dir()).resolve()
    rows: list[ScorecardRow] = []
    seen: set[str] = set()
    # Iterate newest-last so duplicates by run name keep the latest.
    for entry in ledger.read(root=base):
        results_field = entry.get("results")
        if not results_field:
            continue
        path = Path(results_field)
        if not path.is_absolute():
            path = base / path
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        row = ScorecardRow.from_results(payload)
        # Newer entry wins on duplicate run names.
        if row.run in seen:
            for i, existing in enumerate(rows):
                if existing.run == row.run:
                    rows[i] = row
                    break
        else:
            rows.append(row)
            seen.add(row.run)
    return rows


def render_scorecard(rows: list[ScorecardRow]) -> str:
    """Render the markdown scorecard table from a list of rows."""
    headers = [
        "dataset", "recipe",
        "n train/val/test", "val F1", "thr",
        "test F1", "CI95", "cont-recall", "AP",
        "test src",
    ]
    lines = [
        "| " + " | ".join(headers) + " |",
        "|" + "|".join(["---"] * len(headers)) + "|",
    ]
    for row in rows:
        ci = (
            f"{row.test_f1_ci[0]:.3f}–{row.test_f1_ci[1]:.3f}"
            if row.test_f1_ci else "—"
        )
        lines.append("| " + " | ".join([
            row.dataset or "—",
            row.recipe or "—",
            f"{row.n_train}/{row.n_val}/{row.n_test}",
            _maybe_float(row.val_f1, 3),
            _maybe_float(row.val_threshold, 2),
            _maybe_float(row.test_f1, 3),
            ci,
            _maybe_float(row.test_continuation_recall, 3),
            _maybe_float(row.test_ap, 3),
            _short(row.test_source),
        ]) + " |")
    return "\n".join(lines)


def rebuild_readme(
    readme_path: Path | None = None,
    *,
    root: Path | None = None,
) -> bool:
    """Replace the scorecard region in the README. Returns True if updated.

    Returns False (and prints a hint) when the markers are absent —
    we won't guess where to insert a section in a file we don't own.
    """
    readme_path = readme_path or (smart_turn_module_dir() / "README.md")
    if not readme_path.exists():
        raise FileNotFoundError(f"{readme_path} not found.")

    text = readme_path.read_text()
    if START_MARKER not in text or END_MARKER not in text:
        print(
            f"[wk-st report] {readme_path} has no scorecard markers; "
            f"add `{START_MARKER}` / `{END_MARKER}` around the table "
            "you want auto-rebuilt and re-run."
        )
        return False

    rows = collect_rows(root=root)
    table = render_scorecard(rows)

    pre, _, rest = text.partition(START_MARKER)
    _, _, post = rest.partition(END_MARKER)
    new_text = (
        pre + START_MARKER + "\n\n" + table + "\n\n" + END_MARKER + post
    )
    if new_text != text:
        readme_path.write_text(new_text)
        return True
    return False


# -----------------------------------------------------------------------------


def _maybe_float(v, digits: int) -> str:
    if v is None:
        return "—"
    try:
        return f"{float(v):.{digits}f}"
    except (TypeError, ValueError):
        return str(v)


def _short(s: str | None) -> str:
    if not s:
        return "—"
    return Path(s).name or s
