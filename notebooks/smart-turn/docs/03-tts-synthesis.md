# 03 — TTS-bootstrapped data synthesis

**Status:** not started. Blocked on `02-warmstart.md`.

**Goal:** scale from ~1k human samples to 10k–50k labeled samples by
generating synthetic zh audio with TTS, evaluated strictly on the real
human held-out set.

## The asymmetry that shapes the whole pipeline

**End-of-turn samples are easy to synthesize. Continuation samples are
not.** TTS naturally produces complete utterances with terminal
prosody. It does *not* naturally produce mid-thought cutoffs, filled
pauses (嗯/呃/那个), false starts, or non-final intonation — exactly
the cues that define continuation in real speech.

A naive pipeline trains a model that learns "longer = end-of-turn" and
fails on real audio. Most of the engineering goes into the
continuation class.

## Most important things to do

### Phase A — pipeline at small scale (10k)

- [ ] **Pattern profile** of the 1062 real train samples: end-particle
      frequency by class (吗/呢/吧/啊/了), length distribution, ending
      n-grams, F0 contour stats over last 500 ms. Saved next to the
      dataset; used as a target for synthetic distribution and re-run
      to measure synth-vs-real KL divergence.
- [ ] **Text generation, 10k labeled sentences**, mixed sources:
      ~40% mining (Magicdata Mandarin Conversation, OpenSLR-38, drama
      subtitles), ~50% LLM (Claude/Qwen, conditioned on the pattern
      profile, with explicit `<cut/>` markers in continuation text),
      ~10% template fill.
- [ ] **TTS render**, CosyVoice 2, ≥ 50 voices spanning gender / age /
      region. End-of-turn = render full sentence. Continuation = render
      then cut at the `<cut/>` marker via forced alignment, with mild
      trailing silence.
- [ ] **Audio aug at training time**: MUSAN noise (SNR uniform 5–25
      dB), simulated room IRs, Opus / GSM-AMR codec degradation, mic
      EQ perturbation. Bridges studio-clean TTS to real-world test.
- [ ] **Train two models** at the same hyperparameters / seeds:
      pretrain-only on synthetic, and pretrain-then-fine-tune on real
      `smart-turn-zh` train. Eval both on real human test.

### Phase B — scale to 50k, fix what broke

Conditional on Phase A. Likely work, in priority order:

- Multi-engine TTS (F5-TTS, Index-TTS, GPT-SoVITS) so the model can't
  shortcut on one engine's spectral fingerprint.
- Disfluency injection from real zh transcripts — more authentic than
  LLM-generated fillers.
- Diversified cutoff types: mid-syllable, mid-word, post-particle,
  trailing-breath.
- Voice expansion to ≥ 200 speakers; track per-speaker test F1.

## Exit criteria

**Phase A:**

- Pretrain-only F1 on real test ≥ 0.50. (Below this, the synthetic
  distribution is too far from real — fix the pipeline before scaling.)
- Pretrain+fine-tune beats the strongest `02-warmstart` baseline with
  non-overlapping CIs.
- Continuation-class recall on real test ≥ 0.70 — the canary metric for
  synthesis quality.

**Phase B (= v1 ship bar from MISSION.md):**

- Test F1 ≥ 0.80 with 95% CI lower bound ≥ 0.75.
- Continuation-class recall ≥ 0.85.

## Risks

| Risk | Mitigation |
|---|---|
| Synthetic shortcut (model learns TTS artifact = label) | Multi-engine, heavy audio aug, mix real + synthetic from the start |
| Continuation class collapse on real test | Mid-cut + prosody tags + mining-sourced disfluent text |
| Voice overfit | ≥ 200 speakers in Phase B, track per-speaker F1 |
| Synthesis distracts from cheaper wins | Run small real-data scaling study (1k / 2k / 5k human) early — only fully invest if real data is genuinely the bottleneck |

## What to build first

If only one experiment from this phase, do this 1-week loop:

1. Pattern profile on existing 1062 train samples (no synthesis).
2. Generate **500** samples with the simplest possible pipeline
   (mining-only text, one engine, no fancy cuts) — debug the plumbing.
3. Train `real + 500 synthetic` vs. `real only`. Don't expect a win at
   this scale; you're proving the wiring.

## Results

_Fill in after this phase runs._
