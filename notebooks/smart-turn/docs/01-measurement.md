# 01 — Measurement infra

**Status:** not started.

**Goal:** make every future experiment legible. After this, any run
reports F1 ± 95% CI, multi-seed mean ± std, and per-class recall — and
we trust the numbers.

**Why first:** today's `+4.8pt SpecAugment win` sits inside noise on a
59-sample test set. Without trustworthy eval, every later experiment
(warm-start, TTS synthesis, active learning) is a coin flip we can't
read. This phase is the prerequisite for all of them.

## Most important things to do

- [ ] **Larger held-out set.** Re-export `smart-turn-zh` to ≥ 500 test
      samples (re-run `wk exports create` with adjusted ratios, or
      pull a second labeled batch). 59 is the noise floor.
- [ ] **Seed control.** Add `seed` to `TrainingArguments` in `02_*`
      notebooks; default to `[0, 1, 2]` and run all three.
- [ ] **Bootstrap CI helper** in `smart_turn.py`: resample test
      predictions with replacement (1000×), report 95% interval on F1
      / precision / recall / AP.
- [ ] **Multi-seed aggregation** in `03_compare.ipynb`: mean ± std per
      run, plus per-seed scatter so variance is visible.
- [ ] **Confusion analysis cell** in `03_compare`: bucket errors by
      clip duration, by class, by audio source.

## Exit criteria

- New test set ≥ 500 samples, committed to the dataset adapter.
- Re-running `baseline` and `specaugment` produces seed-aggregated F1
  ± CI with no manual computation.
- We can decide whether the +4.8pt SpecAugment delta is real or noise.

## Results

_Fill in after this phase runs._
