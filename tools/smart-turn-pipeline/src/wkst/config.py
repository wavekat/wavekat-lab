"""Recipe and RunConfig dataclasses.

A ``Recipe`` captures everything that defines a training variant —
``baseline``, ``specaugment``, future ones. A ``RunConfig`` binds a
recipe to a specific dataset (and optional frozen test set) for a
single ``wk-st run`` invocation.

Both are deliberately small and serialisable: they're written verbatim
into ``results.json`` so the run is reproducible from its artifact.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class SpecAugmentCfg:
    """SpecAugment knobs. Matches `smart_turn.spec_augment` signature."""

    n_time_masks: int = 2
    time_mask_max: int = 40
    n_freq_masks: int = 2
    freq_mask_max: int = 15


@dataclass(frozen=True)
class Recipe:
    """A training variant. One per ``02_<letter>_*.ipynb`` today."""

    name: str
    base_model: str = "openai/whisper-tiny"
    target_sr: int = 16_000
    chunk_length: int = 8

    epochs: int = 8
    batch_size: int = 16
    eval_batch_size: int = 32
    grad_accum: int = 1

    learning_rate: float = 5e-5
    warmup_ratio: float = 0.1
    weight_decay: float = 0.01

    augment: SpecAugmentCfg | None = None
    seed: int = 42

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class RunConfig:
    """One ``wk-st run`` invocation.

    ``dataset_dir`` and ``test_dir`` are absolute paths after ingest
    has resolved any ``--export-id`` argument. ``checkpoint_dir`` is
    where the trainer writes; ``run_name`` is the leaf directory under
    ``checkpoints/<dataset>/`` and matches the recipe name unless the
    user overrode it via ``--run-name``.
    """

    recipe: Recipe
    dataset_dir: Path
    checkpoint_dir: Path
    run_name: str
    dataset_name: str

    test_dir: Path | None = None
    warm_start_from: Path | None = None
    export_id: str | None = None
    test_export_id: str | None = None

    extra: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "recipe": self.recipe.as_dict(),
            "dataset_dir": str(self.dataset_dir),
            "checkpoint_dir": str(self.checkpoint_dir),
            "run_name": self.run_name,
            "dataset_name": self.dataset_name,
            "test_dir": str(self.test_dir) if self.test_dir else None,
            "warm_start_from": (
                str(self.warm_start_from) if self.warm_start_from else None
            ),
            "export_id": self.export_id,
            "test_export_id": self.test_export_id,
            "extra": dict(self.extra),
        }
