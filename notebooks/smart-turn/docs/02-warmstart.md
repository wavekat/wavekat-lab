# 02 — Warm-start + audio aug

**Status:** not started. Blocked on `01-measurement.md`.

**Goal:** establish strong reference points before investing in TTS
synthesis. So we know what synthesis has to beat.

**Why before synthesis:** these are cheap (no new data needed) and may
close most of the gap on their own. If warm-starting from
`pipecat-ai/smart-turn-v3` gets us to F1 ≥ 0.80, the case for a 50k
synthesis pipeline weakens significantly.

## Most important things to do

- [ ] **Zero-shot upstream baseline.** Score `smart-turn-v3` ONNX
      directly on the zh test set with `score_onnx`. This is the floor
      a zh-specific model has to beat.
- [ ] **Warm-start fine-tune.** New `02_c_train_warmstart.ipynb`:
      replace `BASE_MODEL = "openai/whisper-tiny"` with
      `pipecat-ai/smart-turn-v3` weights (encoder + classifier), then
      fine-tune on `smart-turn-zh`. Hypothesis: 270k turn-taking prior
      transfers despite being English.
- [ ] **Audio augmentation.** New `02_d_train_audioaug.ipynb` adding
      MUSAN noise mix, mild gain perturbation, and codec degradation
      (Opus 8/16 kbps) on top of SpecAugment. Composable with synthesis
      later.

## Exit criteria

- Two new scorecard rows with seed-aggregated F1 ± CI.
- We know which of `whisper-tiny + SpecAug`, `warm-start`, or
  `whisper-tiny + audio-aug` is the strongest non-synthesis baseline.
- Decision: does the strongest baseline already meet the v1 bar in
  `MISSION.md`? If yes, ship it; if no, proceed to `03-tts-synthesis`.

## Results

_Fill in after this phase runs._
