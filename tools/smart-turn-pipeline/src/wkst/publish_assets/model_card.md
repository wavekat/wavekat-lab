---
license: bsd-2-clause
library_name: onnxruntime
pipeline_tag: voice-activity-detection
base_model: pipecat-ai/smart-turn-v3
tags:
  - turn-detection
  - smart-turn
  - pipecat
  - voice
  - onnx
language:
  - zh
---

# WaveKat Smart Turn (ONNX)

Language-specialized fine-tunes of [**Pipecat Smart Turn v3**](https://github.com/pipecat-ai/smart-turn), exported to the same ONNX contract as upstream so they drop into existing Pipecat and `wavekat-turn` pipelines with no code changes.

> [!IMPORTANT]
> **Pipecat owns the architecture.** WaveKat contributes language-specialized weights only. The training recipe, ONNX export pipeline, and the v3 model architecture (Whisper-Tiny encoder + binary classification head) all come from [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn) and the upstream weights at [pipecat-ai/smart-turn-v3](https://huggingface.co/pipecat-ai/smart-turn-v3), released under **BSD 2-Clause**. This repo inherits that license.

## Repository layout

```
wavekat/smart-turn-ONNX
├── README.md                     ← this file
├── zh/
│   ├── smart-turn-cpu.onnx       ← Mandarin fine-tune (int8, ~8 MB)
│   └── results.json              ← test-set metrics for this checkpoint
└── …/                            ← future languages (ja, yue, …)
```

Every language directory holds the same architecture, frozen to the Pipecat v3 ONNX contract:

| Role   | Tensor name      | Shape          | dtype   |
|--------|------------------|----------------|---------|
| Input  | `input_features` | `[B, 80, 800]` | float32 |
| Output | `logits`         | `[B, 1]`       | float32 (sigmoid fused — threshold at 0.5) |

Audio pipeline: 16 kHz mono, 8-second window, Whisper-style log-mel features (Slaney, `n_fft=400`, `hop=160`, 80 mels).

## Usage

### Rust — [`wavekat-turn`](https://github.com/wavekat/wavekat-turn)

```rust
use wavekat_turn::audio::{PipecatSmartTurn, SmartTurnVariant, SmartTurnLang};

let detector = PipecatSmartTurn::with_variant(
    SmartTurnVariant::Wavekat(SmartTurnLang::Zh),
)?;
```

`wavekat-turn` resolves the file via `hf-hub` and caches it under `$HF_HOME/hub/`. Set `WAVEKAT_TURN_MODEL_DIR` to a directory containing `<lang>/smart-turn-cpu.onnx` to skip the download for offline / CI builds.

### Python — [Pipecat](https://github.com/pipecat-ai/smart-turn)

```python
from huggingface_hub import hf_hub_download
from smart_turn import SmartTurnAnalyzer  # upstream Pipecat package

onnx_path = hf_hub_download("wavekat/smart-turn-ONNX", "zh/smart-turn-cpu.onnx")
analyzer = SmartTurnAnalyzer(model_path=onnx_path)
```

Same model class as upstream — only the weights differ.

## Languages

<!-- wkst:languages:start -->
<!-- wkst:languages:end -->

## License & attribution

- **Architecture and training recipe:** [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn), BSD 2-Clause. © 2024 Daily.
- **Upstream weights:** [pipecat-ai/smart-turn-v3](https://huggingface.co/pipecat-ai/smart-turn-v3), BSD 2-Clause.
- **WaveKat fine-tuned weights in this repo:** BSD 2-Clause (matching upstream).

If you build on this work, please cite Pipecat first and then this repo as the source of the language-specialized weights.

```
BSD 2-Clause License

Copyright (c) 2024, Daily
Copyright (c) 2026, WaveKat

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```
