"""``wk-st publish`` — stage a checkpoint for HuggingFace and upload.

Mirrors the wavekat-tts publishing pattern (``tools/qwen3-tts-onnx``):
package the artifact into a layout that matches the consuming repo's
expectations, then push to a HuggingFace model repo. Differences vs
wavekat-tts:

- We publish a **fine-tune** rather than an ONNX export of an upstream
  model. The source is a local checkpoint produced by ``wk-st run`` +
  ``wk-st export``.
- The target HF repo (``wavekat/smart-turn-ONNX``) holds **per-language
  subdirectories**. Each publish touches only one language's files so
  other languages aren't disturbed.
- The on-disk file name is renamed to ``smart-turn-cpu.onnx`` to match
  what the ``wavekat-turn`` Rust loader (``audio::wavekat_download``)
  expects, and what the Pipecat Python loader uses upstream.

This module has **no heavy ML dependencies** — staging and metadata
extraction are pure Python plus stdlib. Only the optional ``upload()``
path imports ``huggingface_hub``.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

# Default HuggingFace repo for WaveKat Smart Turn fine-tunes. Override with
# ``--hf-repo`` if publishing to a fork / staging org.
DEFAULT_HF_REPO = "wavekat/smart-turn-ONNX"

# The file name expected by both:
#   - ``wavekat-turn`` (Rust): ``crates/wavekat-turn/src/audio/wavekat_download.rs``
#   - Pipecat (Python):        ``smart_turn.SmartTurnAnalyzer(model_path=…)``
PUBLISHED_ONNX_NAME = "smart-turn-cpu.onnx"

# Asset templates bundled with the wheel.
_ASSETS = Path(__file__).resolve().parent / "publish_assets"
_MODEL_CARD_TEMPLATE = _ASSETS / "model_card.md"
_GITATTRIBUTES = _ASSETS / "gitattributes"

# Sentinel markers inside the model card for the per-language section.
_LANG_BEGIN = "<!-- wkst:languages:start -->"
_LANG_END = "<!-- wkst:languages:end -->"


@dataclass(frozen=True)
class PublishPlan:
    """Files staged for upload.

    Paths are relative to ``staging_dir`` to keep error output portable
    and to make dry-run inspection easy.
    """

    staging_dir: Path
    lang: str
    onnx_dest: Path
    results_dest: Path
    model_card_dest: Path
    gitattributes_dest: Path
    hf_repo: str
    revision: str


def stage_run(
    *,
    checkpoint_dir: Path,
    lang: str,
    staging_dir: Path,
    hf_repo: str = DEFAULT_HF_REPO,
    revision: str = "main",
    onnx_override: Path | None = None,
) -> PublishPlan:
    """Stage a single run's ONNX + metadata under ``staging_dir``.

    Layout produced::

        <staging_dir>/
        ├── README.md
        ├── .gitattributes
        └── <lang>/
            ├── smart-turn-cpu.onnx
            └── results.json

    The staging directory is **wiped** (only the language subdir we are
    publishing, plus the model card and ``.gitattributes``) so re-runs
    are idempotent. We do not delete other languages' subdirs to keep
    the local staging dir reusable across publishes.

    ``onnx_override`` lets callers point at a custom ONNX file (e.g. a
    smoke test against the upstream Pipecat model). When unset, we look
    for ``<checkpoint_dir>/onnx/smart-turn-int8.onnx`` which is what
    ``wk-st export`` produces.
    """
    if not checkpoint_dir.is_dir():
        raise FileNotFoundError(f"checkpoint dir does not exist: {checkpoint_dir}")

    onnx_src = onnx_override or (checkpoint_dir / "onnx" / "smart-turn-int8.onnx")
    if not onnx_src.is_file():
        raise FileNotFoundError(
            f"missing ONNX artifact: {onnx_src}. "
            "Run `wk-st export --checkpoint <dir>` first, or pass --onnx to override."
        )

    lang = lang.strip().lower()
    if not lang or "/" in lang or lang.startswith("."):
        raise ValueError(f"invalid lang code: {lang!r}")

    lang_dir = staging_dir / lang
    lang_dir.mkdir(parents=True, exist_ok=True)

    onnx_dest = lang_dir / PUBLISHED_ONNX_NAME
    results_dest = lang_dir / "results.json"
    model_card_dest = staging_dir / "README.md"
    gitattributes_dest = staging_dir / ".gitattributes"

    shutil.copy2(onnx_src, onnx_dest)
    _write_lang_results(checkpoint_dir, lang, results_dest)
    _write_model_card(model_card_dest, staging_dir)
    shutil.copy2(_GITATTRIBUTES, gitattributes_dest)

    return PublishPlan(
        staging_dir=staging_dir,
        lang=lang,
        onnx_dest=onnx_dest,
        results_dest=results_dest,
        model_card_dest=model_card_dest,
        gitattributes_dest=gitattributes_dest,
        hf_repo=hf_repo,
        revision=revision,
    )


def upload(plan: PublishPlan, *, commit_message: str, token: str | None = None) -> None:
    """Upload the staged language subdir + top-level model card to HuggingFace.

    Two separate uploads on purpose:

    1. ``<lang>/`` — uploaded via ``upload_folder(path_in_repo=lang)`` so
       only files under that prefix are touched. Other languages stay put.
    2. ``README.md`` + ``.gitattributes`` — uploaded as single files so a
       republish of language X doesn't silently revert another language's
       contribution to the shared model card.

    Requires ``huggingface_hub`` (added to the ``train`` extra of this
    pyproject) and an ``HF_TOKEN`` either via ``token=`` or the env.
    """
    from huggingface_hub import HfApi  # imported lazily — keeps tests light

    api = HfApi(token=token)
    api.create_repo(
        repo_id=plan.hf_repo,
        repo_type="model",
        exist_ok=True,
        private=False,
    )
    api.upload_folder(
        folder_path=str(plan.staging_dir / plan.lang),
        repo_id=plan.hf_repo,
        repo_type="model",
        path_in_repo=plan.lang,
        revision=plan.revision,
        commit_message=f"{commit_message} (lang={plan.lang})",
    )
    api.upload_file(
        path_or_fileobj=str(plan.model_card_dest),
        path_in_repo="README.md",
        repo_id=plan.hf_repo,
        repo_type="model",
        revision=plan.revision,
        commit_message=f"{commit_message} (model card)",
    )
    api.upload_file(
        path_or_fileobj=str(plan.gitattributes_dest),
        path_in_repo=".gitattributes",
        repo_id=plan.hf_repo,
        repo_type="model",
        revision=plan.revision,
        commit_message=f"{commit_message} (.gitattributes)",
    )


def _write_lang_results(checkpoint_dir: Path, lang: str, dest: Path) -> None:
    """Write a slim per-language ``results.json`` next to the ONNX file.

    We do not blindly copy the run's ``results.json`` because it carries
    absolute filesystem paths and W&B run IDs that don't belong in a
    public HF mirror. Instead we keep just the fields users care about
    when picking between checkpoints.
    """
    src = checkpoint_dir / "results.json"
    if not src.is_file():
        # Allow publishing without a results.json (e.g. smoke tests).
        # The model card already lists the published languages.
        dest.write_text(
            json.dumps(
                {
                    "lang": lang,
                    "note": (
                        "No results.json found in the source checkpoint. "
                        "This artifact was published without recorded metrics."
                    ),
                },
                indent=2,
            )
        )
        return

    payload = json.loads(src.read_text())

    metrics = payload.get("metrics") or {}
    export_block = payload.get("export") or {}
    int8_block = export_block.get("int8") or {}

    slim = {
        "lang": lang,
        "run_name": payload.get("run_name"),
        "ts": payload.get("ts"),
        "dataset": {
            "n_train": (payload.get("dataset") or {}).get("n_train"),
            "n_val": (payload.get("dataset") or {}).get("n_val"),
            "n_test": (payload.get("dataset") or {}).get("n_test"),
            "export_id": (payload.get("dataset") or {}).get("export_id"),
        },
        "recipe": {
            "name": (payload.get("recipe") or {}).get("name"),
            "kind": (payload.get("recipe") or {}).get("kind"),
            "threshold": (payload.get("recipe") or {}).get("threshold"),
        },
        "metrics": {
            "test": _slim_metrics(metrics.get("test")),
        },
        "export": {
            "int8": {
                "size_mb": int8_block.get("size_mb"),
                "metrics": _slim_metrics(int8_block.get("metrics")),
                "bench": int8_block.get("bench"),
            },
            "drift": export_block.get("drift"),
        },
    }
    dest.write_text(json.dumps(slim, indent=2, ensure_ascii=False))


def _slim_metrics(m: dict | None) -> dict | None:
    """Pick the headline scalar metrics, dropping PR-curve arrays."""
    if not m:
        return None
    keep = (
        "f1",
        "f1_ci95",
        "precision",
        "recall",
        "accuracy",
        "ap",
        "continuation_recall",
        "threshold",
        "n",
    )
    return {k: m[k] for k in keep if k in m}


def _write_model_card(dest: Path, staging_dir: Path) -> None:
    """Copy the template and replace the languages section with a fresh listing.

    The set of languages is derived from whatever ``<lang>/`` subdirs
    exist under ``staging_dir`` at write time. That way, publishing a
    second language ('ja') from the same staging dir naturally extends
    the model card without manual edits.
    """
    template = _MODEL_CARD_TEMPLATE.read_text()

    languages = sorted(
        d.name
        for d in staging_dir.iterdir()
        if d.is_dir() and not d.name.startswith(".")
    )
    lang_block_lines = ["", "| Language | File | Notes |", "|----------|------|-------|"]
    for lang in languages:
        results_path = staging_dir / lang / "results.json"
        note = ""
        if results_path.is_file():
            try:
                slim = json.loads(results_path.read_text())
                f1 = (slim.get("metrics", {}).get("test") or {}).get("f1")
                if isinstance(f1, (int, float)):
                    note = f"test F1 = {f1:.3f}"
            except json.JSONDecodeError:
                pass
        lang_block_lines.append(
            f"| `{lang}` | `{lang}/{PUBLISHED_ONNX_NAME}` | {note} |"
        )
    lang_block_lines.append("")
    lang_block = "\n".join(lang_block_lines)

    if _LANG_BEGIN in template and _LANG_END in template:
        pre, _, rest = template.partition(_LANG_BEGIN)
        _, _, post = rest.partition(_LANG_END)
        rendered = f"{pre}{_LANG_BEGIN}\n{lang_block}\n{_LANG_END}{post}"
    else:
        # Template missing markers — fall back to appending. Defensive
        # against someone editing the template and forgetting them.
        rendered = template + "\n\n" + lang_block
    dest.write_text(rendered)


def publish_run(
    *,
    checkpoint_dir: Path,
    lang: str,
    staging_dir: Path,
    hf_repo: str = DEFAULT_HF_REPO,
    revision: str = "main",
    onnx_override: Path | None = None,
    dry_run: bool = True,
    commit_message: str | None = None,
    token: str | None = None,
) -> PublishPlan:
    """Stage and (unless ``dry_run``) upload a checkpoint to HuggingFace."""
    plan = stage_run(
        checkpoint_dir=checkpoint_dir,
        lang=lang,
        staging_dir=staging_dir,
        hf_repo=hf_repo,
        revision=revision,
        onnx_override=onnx_override,
    )
    if dry_run:
        return plan

    msg = commit_message or f"publish: {lang} fine-tune ({checkpoint_dir.name})"
    upload(plan, commit_message=msg, token=token)
    return plan
