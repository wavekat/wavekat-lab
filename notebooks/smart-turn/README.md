# Smart-Turn notebooks

Workflow notebooks for the binary smart-turn (end-of-turn vs continuation)
task, picking up from a `wk exports adapt smart-turn` snapshot.

| Notebook | Purpose |
|---|---|
| `01_load_export.ipynb` | Load Parquet shards, sanity-check splits / label balance / clip durations, audition a few clips. |
| `02_train.ipynb` | Fine-tune `whisper-tiny` encoder + attention-pool head on `ds["train"]`, validate per epoch, save HF checkpoint. |
| `03_eval.ipynb` | Held-out metrics on `ds["test"]`, ONNX FP32 export, INT8 static quantization, FP32-vs-INT8 latency benchmark. |

## Producing the input

Use [`wavekat-cli`](https://github.com/wavekat/wavekat-cli):

```sh
wk exports create <project-id> \
  --name "smart-turn-zh $(date +%Y-%m-%d)" \
  --review-status approved \
  --label-key end_of_turn \
  --label-key continuation \
  --split random --seed 42 --ratios 0.8,0.1,0.1

wk exports download <export-id> --out ./snapshots/smart-turn-zh
wk exports adapt smart-turn \
  --export-dir ./snapshots/smart-turn-zh \
  --out ./datasets/smart-turn-zh \
  --language zh
```

The notebooks default to `../../datasets/smart-turn-zh` relative to
this directory — override `EXPORT_DIR` in the first code cell if your
output landed elsewhere.

## Install heavy deps

`02_train.ipynb` and `03_eval.ipynb` need PyTorch, transformers, and
ONNX Runtime — these aren't in the lab's base env (the loader notebook
doesn't need them). Pull them in via the `smart-turn` extras group:

```sh
uv sync --extra smart-turn
# or:  pip install -e ".[smart-turn]"
```

After this you should be able to `import torch` from the same kernel
JupyterLab is using (`uv run jupyter lab`).

## Training environment

`02_train.ipynb` needs a GPU to be practical. The reference recipe
(Azure NC4as_T4_v3, Tesla T4 16 GB, Docker + nvidia-container-toolkit,
`whisper-tiny` encoder fine-tune) lives upstream at
[pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn) and
in the team's GPU-VM playbook — these notebooks adopt the same model
architecture and quantization pipeline so artifacts are wire-compatible
with pipecat consumers.

Hyperparameters in `02_train.ipynb` are tuned for ~1k-sample exports
(batch 16, 8 epochs, eval per epoch). For the upstream-scale 270k
dataset, raise the batch size and drop epochs back to upstream defaults.

`03_eval.ipynb` writes ONNX artifacts into
`../../checkpoints/smart-turn-zh/onnx/`; the INT8 file is what plugs
into pipecat's `SmartTurnAnalyzer` for on-device end-of-turn detection.
