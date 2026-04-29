# Mission

Build the best Chinese end-of-turn detector for real-time voice agents.
"Best" means the model that, on real human-labeled zh conversation
audio, decides fastest and most accurately whether the speaker is done.

## What we're optimizing, in order

1. **Test F1 on real human-labeled zh audio**, with bootstrap 95% CI
   tight enough that wins aren't noise. The only metric that decides
   shipping.
2. **Continuation-class recall.** Cutting users off mid-thought is the
   failure mode users hate most.
3. **CPU latency** of the INT8 ONNX export — sub-100 ms on a modern
   laptop CPU core, on-device deployable.
4. **Wire-compat with pipecat's `SmartTurnAnalyzer`** — same input
   contract so artifacts drop into existing consumers.

## Out of scope

- General dialogue modelling. We predict end-of-turn only.
- Multi-language single model. Separate model per language is fine.
- Beating English smart-turn-v3 on English.

## v1 ship bar

On a held-out test set of **≥ 500 human-labeled real zh clips**:

- Test F1 ≥ 0.80, bootstrap 95% CI lower bound ≥ 0.75.
- Continuation-class recall ≥ 0.85.
- INT8 ONNX latency ≤ 100 ms on a single laptop CPU core.
- Strictly beats both `pipecat-ai/smart-turn-v3` zero-shot on the same
  test set and the current `specaugment` checkpoint, with
  non-overlapping CIs.
