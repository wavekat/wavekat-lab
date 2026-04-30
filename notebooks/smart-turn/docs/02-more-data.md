# 02 — Get more training data

**Status:** in progress.

**Goal:** scale from ~1K human-labeled samples to 10K+ labeled
training samples by combining four data sources, ordered by speed to
first labeled sample.

## Why this is now phase 2

The previous phase docs (`01-measurement`, `02-warmstart`) are
dropped: the dataset bottleneck dominates everything else. With 1062
train samples, no modeling trick (warm-start, SpecAugment, audio aug)
compounds — every improvement sits inside noise. More data first, then
modeling.

## The four data sources, ranked by speed-to-value

Run them in parallel where the work doesn't conflict; the sequencing
below is about **what unblocks what**, not strict ordering.

### Tier 1 — Mine public zh conversation corpora (fastest, plan A)

The fastest path to **real-distribution audio** with **real
continuations**. Public conversational Chinese corpora ship with ASR
transcripts and speaker-turn timestamps — turn-detection labels can be
derived directly from those, no model needed.

Targets, in order of expected fit:

- **MAGICDATA-RAMC** — 180 h of multi-speaker spontaneous conversation
  with diarization + transcripts. Free for research. Best fit by a
  wide margin: the audio IS turn-taking by construction.
- **AISHELL-4** — 120 h of meeting recordings. Real disfluencies, real
  overlap, multi-speaker.
- **OpenSLR-38 / Free ST Chinese Mandarin Corpus** — 102 h, spontaneous.
- **DiDi Speech** — driver-assistance conversational data. Less open;
  worth checking access.

**Auto-labeling rule** (labels-by-construction from diarization):

- For each speaker-turn boundary, take the trailing 8 s ending exactly
  at the boundary → `end_of_turn = 1`.
- Take a random 8 s window cut before turn end (with ≥ 1 s of speech
  remaining after the cut) → `end_of_turn = 0` (continuation).
- One pair per turn ⇒ balanced labels by construction.

This is the single most important property of mining: **continuations
are real mid-utterance audio**, with real prosody, real fillers, real
hesitations. That's exactly what TTS struggles to produce.

**Validation before scaling:** sample 200 mined clips, audition,
record per-class label correctness. If noise > 5%, tighten the rules
(e.g., require minimum silence after end-of-turn boundary, exclude
overlapping speech). If noise ≤ 5%, bulk-mine.

**Expected yield in week 1:** 5K–20K labeled clips across two corpora.

### Tier 2 — TTS synthesis (supplementary)

Adds controlled coverage where mining is thin: specific final
particles (吗/呢/吧/啊/了), specific syntactic patterns, voice
demographics underrepresented in MAGICDATA-RAMC, and end-of-turn
volume.

Less urgent than mining because:
- Mining already gives us natural continuations — the hardest TTS
  failure mode is no longer load-bearing.
- TTS quality on the end-of-turn class is fine; that's where
  synthesis adds the most cheaply.

**Pipeline** (compressed from the original synthesis plan):

- Pattern profile from mined + human data: end-particle frequency,
  ending n-grams, length distribution.
- Text generation: 60% mining-sourced sentences (mid-clause cuts for
  continuation, complete sentences for end-of-turn), 40% LLM
  generation conditioned on the pattern profile.
- TTS render with CosyVoice 2 first (≥ 50 voices), expand to F5-TTS /
  Index-TTS in v2 if needed.
- For continuation TTS samples: cut audio mid-utterance at forced-alignment
  boundaries.
- Audio aug at training time: MUSAN noise mix (SNR 5–25 dB),
  simulated room IRs, Opus / GSM-AMR codec degradation.

**Expected yield:** 10K–50K synthetic clips in weeks 2–3.

### Tier 3 — Human labeling on real wavekat product audio

The gold-standard source. If wavekat voice agents see real Chinese
traffic, recordings of that traffic match deployment distribution
exactly — by construction.

- Capture conversation audio from production (with consent and
  appropriate retention policy).
- Segment by detected speaker turn.
- Send to in-house or crowd labelers via the existing `wk exports`
  pipeline.
- Maintain separate splits to avoid leakage with mined / synthetic data.

Slowest per-sample, highest-quality. Run continuously in the
background — even 200 labeled clips/week compounds.

**Most important product of Tier 3:** grow the held-out **test set**
beyond 59 samples. Test integrity matters more than train scale; we
can't trust any v1 metric on a 59-sample test.

### Tier 4 — Active learning (after v1 ships)

Once Tiers 1–3 produce a v1 model, run it on unlabeled real audio,
sort by prediction uncertainty (probability near threshold), send
top-N uncertain clips to Tier 3 labelers. The labelers' time goes to
the samples that move the model most.

Not a starting source — needs a v1 model first.

## Sequencing

```
week 1                week 2-3              week 4              ongoing
─────────             ─────────             ─────────           ─────────
mining pipeline       TTS synthesis         train v1            human labeling
mine 5-20K            generate 10-50K       on combined data    + active learning
└─ verify 200         └─ verify 200         └─ eval on real
   for label noise       for distribution       human test
                         match
```

Mining unblocks everything: TTS uses mining-extracted patterns to
condition its text generation; human labeling priorities are informed
by what mining covered poorly; active learning runs against v1 trained
on mining + TTS data.

## Dataset size targets

| Phase | Train | Val | Test | Sources |
|---|---|---|---|---|
| v0 (now) | 1062 | 59 | 59 | wk human labels only |
| v1 (week 4) | 5K+ | 500+ | 500+ | mining + TTS + wk humans |
| v2 (week 8) | 20K+ | 1K+ | 1K+ | + active learning |

**Test split discipline:** held-out human-labeled clips only. Never
include mined or synthetic data in test. Eval integrity > eval size.
Tier 3 is the only source allowed to grow test.

## Most important things to do (week 1)

- [ ] **Pick first mining corpus.** Default: MAGICDATA-RAMC. Confirm
      license / access before building anything else.
- [ ] **Build the mining notebook.** Suggested location:
      `notebooks/smart-turn-mining/01_mine_magicdata.ipynb` (sibling
      to `notebooks/smart-turn/` — produces datasets, not models).
      Output: Parquet shards in the same schema as
      `wk exports adapt smart-turn` so the existing training notebooks
      consume them unchanged.
- [ ] **Calibrate auto-labels.** Sample 200 mined clips, audition,
      record per-class correctness. Tighten rules if noise > 5%.
- [ ] **Train mining-only baseline.** Same hyperparameters as
      `02_a_train_baseline`, swap dataset to mined-only. Sanity-checks
      that the mined distribution is learnable.
- [ ] **Score on real human test set.** F1 vs. current `specaugment`
      baseline tells us whether mining alone is enough, or whether the
      wk human labels still need to be mixed in.

## Exit criteria for v1 (week 4)

- ≥ 5K training samples across mining, TTS, and existing human labels.
- ≥ 500 held-out human-labeled test samples (Tier 3 work).
- v1 model F1 on real human test strictly beats `specaugment` (0.69)
  by a margin large enough to read without CI math (target: +5pt).
- Continuation-class recall on real test ≥ 0.80.

## Risks

| Risk | Mitigation |
|---|---|
| Mining label noise from imperfect speaker diarization | Verify 200 → calibrate rules; restrict to well-diarized corpora |
| Mining yields homogeneous voices / scripted topics | Mix RAMC + AISHELL-4 + others for diversity |
| Distribution gap between mined and wavekat product audio | Tier 3 (real product labels) and Tier 4 (active learning) close it over time |
| TTS underperforms once mining is in place | That's fine — mining is plan A, TTS is bonus coverage |
| Test set stays at 59 samples | Tier 3 priority: grow real human test to ≥ 500 before declaring v1 |

## Results

_Fill in as the phase runs._
