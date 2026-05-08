"""SpecAugment recipe — mirrors ``02_b_train_specaugment.ipynb``.

Same as baseline plus per-sample time + frequency masking on the train
split only. Mask params match the upstream defaults.
"""

from __future__ import annotations

from wkst.config import Recipe, SpecAugmentCfg

RECIPE = Recipe(
    name="specaugment",
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
    augment=SpecAugmentCfg(
        n_time_masks=2,
        time_mask_max=40,
        n_freq_masks=2,
        freq_mask_max=15,
    ),
    seed=42,
)
