"""Shared model, dataset, and training helpers for the smart-turn notebooks.

Lives next to the notebooks so each variant
(`02_train_baseline.ipynb`, `02_train_specaugment.ipynb`, ...) stays
thin: import from here, set its own config block, run.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import numpy as np
import torch
import torch.nn as nn
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
)
from torch.utils.data import Dataset
from transformers import WhisperConfig, WhisperPreTrainedModel
from transformers.models.whisper.modeling_whisper import WhisperEncoder


# -----------------------------------------------------------------------------
# Model
# -----------------------------------------------------------------------------


class SmartTurnModel(WhisperPreTrainedModel):
    """Whisper encoder + attention pooling + binary classifier."""

    def __init__(self, config: WhisperConfig):
        super().__init__(config)
        config.max_source_positions = 400
        self.encoder = WhisperEncoder(config)
        hidden = config.d_model

        self.pool_attention = nn.Sequential(
            nn.Linear(hidden, 256),
            nn.Tanh(),
            nn.Linear(256, 1),
        )
        self.classifier = nn.Sequential(
            nn.Linear(hidden, 256),
            nn.LayerNorm(256),
            nn.GELU(),
            nn.Dropout(0.1),
            nn.Linear(256, 64),
            nn.GELU(),
            nn.Linear(64, 1),
        )
        # Class-balance weight for BCE — set once via set_pos_weight() from
        # the full train split. Per-batch recomputation is unstable on
        # small batches.
        self.register_buffer("pos_weight", torch.tensor(1.0))
        self.post_init()

    def set_pos_weight(self, value: float) -> None:
        with torch.no_grad():
            self.pos_weight.fill_(float(value))

    def forward(self, input_features, labels=None):
        enc = self.encoder(input_features).last_hidden_state
        attn = torch.softmax(self.pool_attention(enc).squeeze(-1), -1)
        pooled = torch.bmm(attn.unsqueeze(1), enc).squeeze(1)
        logits = self.classifier(pooled).squeeze(-1)
        probs = torch.sigmoid(logits)
        loss = None
        if labels is not None:
            loss = nn.BCEWithLogitsLoss(pos_weight=self.pos_weight)(logits, labels.float())
        return {"loss": loss, "logits": probs}


def build_model(base_model: str) -> SmartTurnModel:
    """Construct SmartTurnModel and load pretrained encoder weights."""
    config = WhisperConfig.from_pretrained(base_model)
    model = SmartTurnModel(config)
    pretrained = SmartTurnModel.from_pretrained(
        base_model, config=config, ignore_mismatched_sizes=True
    )
    model.encoder.load_state_dict(pretrained.encoder.state_dict())
    del pretrained
    return model


def pos_weight_from_labels(labels) -> float:
    """Constant pos_weight from full train labels, clamped to [0.1, 10]."""
    arr = np.asarray(labels, dtype=np.int64)
    n_pos = int(arr.sum())
    n_neg = int((arr == 0).sum())
    return max(0.1, min(10.0, n_neg / max(n_pos, 1)))


def pick_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


# -----------------------------------------------------------------------------
# Dataset + augmentation
# -----------------------------------------------------------------------------


def truncate_to_last_n_seconds(audio_array: np.ndarray, sr: int, n_seconds: int) -> np.ndarray:
    """Keep the trailing n_seconds; zero-pad the start if shorter."""
    max_samples = sr * n_seconds
    if len(audio_array) > max_samples:
        return audio_array[-max_samples:]
    if len(audio_array) < max_samples:
        pad = np.zeros(max_samples - len(audio_array), dtype=audio_array.dtype)
        return np.concatenate([pad, audio_array])
    return audio_array


def spec_augment(
    features: torch.Tensor,
    n_time_masks: int = 2,
    time_mask_max: int = 40,
    n_freq_masks: int = 2,
    freq_mask_max: int = 15,
) -> torch.Tensor:
    """Random time + frequency masking. features: (n_mels, n_time)."""
    n_mels, n_time = features.shape
    for _ in range(n_time_masks):
        t = int(np.random.randint(0, time_mask_max + 1))
        if 0 < t < n_time:
            t0 = int(np.random.randint(0, n_time - t))
            features[:, t0:t0 + t] = 0
    for _ in range(n_freq_masks):
        f = int(np.random.randint(0, freq_mask_max + 1))
        if 0 < f < n_mels:
            f0 = int(np.random.randint(0, n_mels - f))
            features[f0:f0 + f, :] = 0
    return features


class SmartTurnDataset(Dataset):
    """Wraps a HF dataset, extracting mel features on the fly.

    `augment` is an optional callable taking and returning a (n_mels,
    n_time) tensor. Use a callable for the train split; pass None for
    eval/test so metrics are deterministic.
    """

    def __init__(
        self,
        hf_dataset,
        feature_extractor,
        target_sr: int,
        chunk_length: int,
        augment: Callable[[torch.Tensor], torch.Tensor] | None = None,
    ):
        self.ds = hf_dataset
        self.fe = feature_extractor
        self.target_sr = target_sr
        self.chunk_length = chunk_length
        self.augment = augment

    def __len__(self):
        return len(self.ds)

    def __getitem__(self, idx):
        sample = self.ds[idx]
        audio = sample["audio"]
        arr = np.array(audio["array"], dtype=np.float32)
        arr = truncate_to_last_n_seconds(arr, audio["sampling_rate"], self.chunk_length)

        features = self.fe(
            arr,
            sampling_rate=self.target_sr,
            return_tensors="pt",
            padding="max_length",
            max_length=self.chunk_length * self.target_sr,
            truncation=True,
            do_normalize=True,
        )
        feat = features["input_features"].squeeze(0)
        if self.augment is not None:
            feat = self.augment(feat.clone())
        return {
            "input_features": feat,
            "labels": torch.tensor(float(sample["endpoint_bool"])),
        }


# -----------------------------------------------------------------------------
# Metrics + threshold tuning
# -----------------------------------------------------------------------------


THRESHOLDS = np.linspace(0.05, 0.95, 91)


def compute_metrics_with_threshold(eval_pred):
    """HF Trainer compute_metrics: F1 at the per-eval best threshold."""
    probs, labels = eval_pred
    probs = np.asarray(probs).flatten()
    labels = np.asarray(labels).astype(int).flatten()
    f1s = np.array([
        f1_score(labels, (probs > t).astype(int), zero_division=0) for t in THRESHOLDS
    ])
    best = int(np.argmax(f1s))
    thr = float(THRESHOLDS[best])
    preds = (probs > thr).astype(int)
    return {
        "accuracy": accuracy_score(labels, preds),
        "precision": precision_score(labels, preds, zero_division=0),
        "recall": recall_score(labels, preds, zero_division=0),
        "f1": float(f1s[best]),
        "threshold": thr,
    }


def evaluate_and_save_threshold(trainer, eval_dataset, checkpoint_dir: Path) -> dict:
    """Pick best threshold on `eval_dataset`, write threshold.json, plot
    PR + F1-vs-threshold. Returns the saved payload."""
    import matplotlib.pyplot as plt  # local — notebooks-only dependency

    out = trainer.predict(eval_dataset)
    probs = np.asarray(out.predictions).flatten()
    labels = np.asarray(out.label_ids).astype(int).flatten()

    f1s = np.array([
        f1_score(labels, (probs > t).astype(int), zero_division=0) for t in THRESHOLDS
    ])
    best = int(np.argmax(f1s))
    best_thr = float(THRESHOLDS[best])
    best_f1 = float(f1s[best])
    default_f1 = float(f1_score(labels, (probs > 0.5).astype(int), zero_division=0))

    payload = {
        "threshold": best_thr,
        "val_f1": best_f1,
        "val_f1_at_0.5": default_f1,
    }
    (Path(checkpoint_dir) / "threshold.json").write_text(json.dumps(payload, indent=2))

    prec, rec, _ = precision_recall_curve(labels, probs)
    ap = average_precision_score(labels, probs)
    chosen = (probs > best_thr).astype(int)
    cp = precision_score(labels, chosen, zero_division=0)
    cr = recall_score(labels, chosen, zero_division=0)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 4))
    ax1.plot(rec, prec, color="C0")
    ax1.scatter([cr], [cp], color="C3", zorder=5,
                label=f"thr={best_thr:.2f}  F1={best_f1:.3f}")
    ax1.set_xlabel("recall")
    ax1.set_ylabel("precision")
    ax1.set_title(f"Precision–Recall  (AP={ap:.3f})")
    ax1.set_xlim(0, 1.02)
    ax1.set_ylim(0, 1.02)
    ax1.grid(alpha=0.3)
    ax1.legend(loc="lower left")

    ax2.plot(THRESHOLDS, f1s, color="C2")
    ax2.axvline(best_thr, color="C3", linestyle="--", label=f"best thr={best_thr:.2f}")
    ax2.set_xlabel("threshold")
    ax2.set_ylabel("F1")
    ax2.set_title("F1 vs threshold")
    ax2.set_ylim(0, 1.02)
    ax2.grid(alpha=0.3)
    ax2.legend(loc="lower center")
    plt.tight_layout()
    plt.show()

    print(f"best threshold : {best_thr:.3f}   val F1 = {best_f1:.4f}")
    print(f"vs 0.5 default :              val F1 = {default_f1:.4f}  "
          f"(Δ {best_f1 - default_f1:+.4f})")
    return payload


# -----------------------------------------------------------------------------
# Cross-run comparison
# -----------------------------------------------------------------------------


def score_run(
    checkpoint_dir: Path,
    hf_test_split,
    target_sr: int,
    chunk_length: int,
    device: torch.device,
    batch_size: int = 16,
) -> dict:
    """Load checkpoint + its `threshold.json` and score it on `hf_test_split`.

    Returns dict with: threshold, probs, labels, accuracy, precision,
    recall, f1, average_precision. Used by `04_compare.ipynb` to lay
    runs side by side without re-implementing inference per notebook.
    """
    from torch.utils.data import DataLoader
    from transformers import WhisperFeatureExtractor

    checkpoint_dir = Path(checkpoint_dir)
    fe = WhisperFeatureExtractor.from_pretrained(checkpoint_dir)
    model = SmartTurnModel.from_pretrained(checkpoint_dir).to(device).eval()

    threshold_path = checkpoint_dir / "threshold.json"
    threshold = (
        float(json.loads(threshold_path.read_text())["threshold"])
        if threshold_path.exists() else 0.5
    )

    dataset = SmartTurnDataset(
        hf_test_split, fe, target_sr, chunk_length, augment=None,
    )
    loader = DataLoader(dataset, batch_size=batch_size, num_workers=0)
    probs_chunks, labels_chunks = [], []
    with torch.no_grad():
        for batch in loader:
            feats = batch["input_features"].to(device)
            out = model(feats)
            probs_chunks.append(out["logits"].detach().cpu().numpy())
            labels_chunks.append(batch["labels"].numpy())
    probs = np.concatenate(probs_chunks)
    labels = np.concatenate(labels_chunks).astype(int)
    preds = (probs > threshold).astype(int)

    return {
        "threshold": threshold,
        "probs": probs,
        "labels": labels,
        "accuracy": float(accuracy_score(labels, preds)),
        "precision": float(precision_score(labels, preds, zero_division=0)),
        "recall": float(recall_score(labels, preds, zero_division=0)),
        "f1": float(f1_score(labels, preds, zero_division=0)),
        "average_precision": float(average_precision_score(labels, probs)),
    }


def score_onnx(
    onnx_path: Path,
    feature_extractor_source: str,
    hf_test_split,
    target_sr: int,
    chunk_length: int,
    threshold: float = 0.5,
    input_name: str = "input_features",
) -> dict:
    """Score an external ONNX model on `hf_test_split`.

    Used to compare against pretrained baselines like `pipecat-ai/smart-turn-v3`,
    whose ONNX takes the same `(1, 80, chunk_length*100)` mel input we already
    produce. `feature_extractor_source` is anything `WhisperFeatureExtractor.from_pretrained`
    accepts (e.g. `"openai/whisper-tiny"`) — the upstream ONNX expects
    Whisper-tiny's preprocessing, not ours.
    """
    import onnxruntime as ort
    from transformers import WhisperFeatureExtractor

    fe = WhisperFeatureExtractor.from_pretrained(feature_extractor_source)
    dataset = SmartTurnDataset(
        hf_test_split, fe, target_sr, chunk_length, augment=None,
    )
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])

    probs, labels = [], []
    for i in range(len(dataset)):
        item = dataset[i]
        feats = item["input_features"].unsqueeze(0).numpy()
        out = sess.run(None, {input_name: feats})[0]
        probs.append(float(np.squeeze(out)))
        labels.append(int(item["labels"]))
    probs = np.array(probs)
    labels = np.array(labels, dtype=int)
    preds = (probs > threshold).astype(int)

    return {
        "threshold": threshold,
        "probs": probs,
        "labels": labels,
        "accuracy": float(accuracy_score(labels, preds)),
        "precision": float(precision_score(labels, preds, zero_division=0)),
        "recall": float(recall_score(labels, preds, zero_division=0)),
        "f1": float(f1_score(labels, preds, zero_division=0)),
        "average_precision": float(average_precision_score(labels, probs)),
    }
