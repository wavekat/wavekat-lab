"""Baseline recipe — mirrors ``02_a_train_baseline.ipynb``.

Pinned ``pos_weight``, F1-best threshold sweep, no augmentation. This
is the reference number every other variant gets compared against.
"""

from __future__ import annotations

from wkst.config import Recipe

RECIPE = Recipe(
    name="baseline",
    base_model="openai/whisper-tiny",
    target_sr=16_000,
    chunk_length=8,
    epochs=8,
    batch_size=16,
    eval_batch_size=32,
    grad_accum=1,
    learning_rate=5e-5,
    warmup_ratio=0.1,
    weight_decay=0.01,
    augment=None,
    seed=42,
)
