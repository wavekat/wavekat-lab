# 02 — Warm-start + audio aug

**Status:** in progress.

**Goal:** establish strong reference points before investing in TTS
synthesis. So we know what synthesis has to beat.

**Why before synthesis:** these are cheap (no new data needed) and may
close most of the gap on their own. If warm-starting from
`pipecat-ai/smart-turn-v3` gets us to F1 ≥ 0.80, the case for a 50k
synthesis pipeline weakens significantly.

## Most important things to do

- [x] **Zero-shot upstream baseline.** Score `pipecat-ai/smart-turn-v3`
      ONNX directly on the zh test set with `score_onnx`. This is the
      floor a zh-specific model has to beat. Notebook:
      `02_c_zero_shot_upstream.ipynb`.
- [ ] **Warm-start fine-tune. BLOCKED — needs proper ONNX → PyTorch
      port.** Hypothesis still stands (the 270k turn-taking prior
      should transfer despite being English), but the simple direct
      `from_pretrained` path is closed off. See "Warm-start blocker"
      below. Defer until the porter is built or upstream publishes
      PyTorch weights.
- [ ] **Audio augmentation.** New `02_d_train_audioaug.ipynb` adding
      noise mix and gain perturbation on top of SpecAugment.
      Independent of the warm-start blocker — promote to next
      concrete deliverable for this phase.

## Warm-start blocker

What we found when investigating:

- `pipecat-ai/smart-turn-v3` on HuggingFace ships **ONNX only**, no
  `pytorch_model.bin`. `pipecat-ai/smart-turn-v2` has PyTorch weights
  but a different architecture (Wav2Vec2-based, not Whisper).
- The repo has five ONNX files. `smart-turn-v3.0.onnx` and the
  `*-cpu.onnx` variants are **INT8-quantized** (~8.7 MB, weight /
  scale / zero_point triples) — porting them back to FP32 is lossy and
  not worth the effort. The `*-gpu.onnx` variants are FP32 (~32 MB)
  and a viable port target.
- The FP32 ONNX names don't fully match our `state_dict` keys.
  Conv1d / LayerNorm / bias initializers carry the original module
  paths (with an `inner.` prefix we can strip). But **`nn.Linear`
  weights** are exported as anonymous `val_NNN` MatMul operands, and
  the upstream exporter (dynamo / FX-based) renames the MatMul nodes
  to `node_MatMul_NN` / `node_linear_N` — so we lose the path info
  needed to map `val_*` → `encoder.layers.X.self_attn.q_proj.weight`.

What it would take to unblock:

- Build a **graph-walking ONNX porter**: trace the ONNX nodes,
  identify each parameter MatMul by its position in the topological
  graph (which `nn.Linear` it represents), transpose the weight
  matrix where needed (ONNX MatMul stores `(in, out)`, PyTorch
  `nn.Linear.weight` stores `(out, in)`), and assemble a full
  `state_dict`. Confirm correctness with a **forward-pass parity
  test**: same input → onnxruntime output vs ported-PyTorch output,
  bitwise close (atol ≤ 1e-5 fp32).
- That's a half-day of focused work, not a notebook. Build it as a
  separate utility (`onnx_porter.py` or similar) with a unit test
  before any warm-start training notebook is written on top.

Alternatives if the porter isn't worth building:

- **Ask upstream to publish FP32 PyTorch weights.** Cheapest if it
  works, slow / depends on others.
- **Train upstream's pipeline ourselves.** They have public training
  data; we'd run their `train.py` and save the resulting PyTorch
  checkpoint. Significant compute.
- **Skip warm-start entirely.** Go straight to `03-tts-synthesis`. The
  data scale-up may make the upstream init less load-bearing than we
  assumed.

## Exit criteria

- Two new scorecard rows with seed-aggregated F1 ± CI.
- We know which of `whisper-tiny + SpecAug`, `warm-start`, or
  `whisper-tiny + audio-aug` is the strongest non-synthesis baseline.
- Decision: does the strongest baseline already meet the v1 bar in
  `MISSION.md`? If yes, ship it; if no, proceed to `03-tts-synthesis`.

## Results

_Fill in after this phase runs._
