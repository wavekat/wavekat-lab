# 03 — MagicData-RAMC mining pipeline

**Status:** plan, not started.

**Goal:** convert the MagicData-RAMC corpus already on disk
(`datasets/MagicData-RAMC/`) into labeled Smart-Turn training clips,
using a multi-source consensus pipeline so the human review queue
focuses only on borderline cases.

This is the concrete implementation of Tier 1 in
[`02-more-data.md`](02-more-data.md). RAMC was picked as the first
mining corpus because it ships with diarization-quality utterance
boundaries (per-speaker `[start, end]` ranges) and free-research
licensing.

## What's already on disk

```
datasets/MagicData-RAMC/
├── DataPartition/                      # train / dev / test split lists
│   ├── train.tsv
│   ├── dev.tsv
│   └── test.tsv
├── KeywordList/
└── MDT2021S003/
    ├── README.txt                      # TXT format spec
    ├── SPKINFO.txt                     # speaker metadata
    ├── UTTERANCEINFO.txt
    ├── TXT/                            # one .txt per session
    │   └── CTS-CN-F2F-2019-11-11-198.txt
    └── WAV/                            # 349 sessions, 16 kHz
        └── CTS-CN-F2F-2019-11-11-198.wav
```

Each TXT row is one diarized speaker turn:

```
[start_time,end_time]  speaker_id  gender,language  transcription
[3.464,6.576]          G00000577   男,普通话         我们今天聊一下环境治理吧，这个问题
[6.648,7.864]          G00000578   男,普通话         啊也行
```

Special markers: `[+]` overlap, `[*]` unintelligible/foreign,
`[LAUGHTER]`, `[SONANT]`, `[MUSIC]`. These are signal, not noise — see
**Filters** below.

## Why this layered design

The user's instinct is right: don't trust any single label source on
its own. RAMC's diarization is good but not perfect; the LLM can
misread truncated text; our own model is the very thing we're trying to
improve, so it can't be the ground truth. **Each source has a
different failure mode**, so consensus-of-three filters out noise that
any one source would let through.

But "all three must agree before we ship" is too strict — it would
throw away most of the 180 hours. The right shape is:

- **Structural labels (RAMC speaker boundaries) are primary.** This is
  the "labels by construction" rule from `02-more-data.md`. The other
  signals are verification, not generation.
- **Auto-accept** when structural + LLM + own-model agree.
- **Send to human review** when any one disagrees, OR when filters
  flag the clip as borderline (overlap, very short turn, near-edge VAD).
- **Auto-reject** only on hard filter violations (overlap markers
  inside the clip, < 200 ms speech, etc.) — never on model
  disagreement alone.

## The four signals

### Signal 1 — Structural label from RAMC (primary)

For each adjacent pair of utterances `(u_i, u_{i+1})` in a session
TXT, sorted by `start_time`:

| Condition | Label for clip ending at `u_i.end` |
|---|---|
| `u_{i+1}.speaker != u_i.speaker` AND gap `(u_{i+1}.start - u_i.end) ≥ 0.3 s` | `end_of_turn = 1` |
| `u_{i+1}.speaker == u_i.speaker` AND gap `< 0.5 s` | `continuation = 1` (this clip is mid-turn for `u_i`'s speaker) |
| Any overlap (`gap < 0`) or `[+]` marker on either side | reject |

Continuation clips are also synthesized by cutting an 8 s window that
ends mid-utterance (at a word-timestamp boundary inside `u_i`, with
≥ 1 s of `u_i` remaining after the cut). One continuation per turn so
classes stay balanced by construction.

### Signal 2 — Our VAD on the full session

Run Silero VAD on the full session WAV, save per-frame probs as in
[`wavekat-turn/training/smart-turn-zh/notebooks/02-vad.ipynb`](../../../../wavekat-turn/training/smart-turn-zh/notebooks/02-vad.ipynb).
Two jobs:

1. **Trim cut points to silence.** End-of-turn clips must end at a VAD
   silence boundary, not mid-word. If the RAMC `end_time` falls inside
   speech (VAD prob > 0.5), nudge to the next frame where prob drops
   below 0.3 for ≥ 100 ms. Reject if no such boundary exists within
   ±300 ms of the RAMC boundary.
2. **Reject overlap.** If VAD shows speech in both the trailing 200 ms
   of `u_i` and the leading 200 ms of `u_{i+1}` (i.e., no real
   silence gap), the structural label is unreliable — drop or send to
   review.

### Signal 3 — Our current smart-turn checkpoint

Run the latest zh checkpoint (whichever beats `specaugment`) on each
candidate clip. This is **not** ground truth; it's a disagreement
detector:

- Where own-model and structural label agree → high-confidence sample.
- Where they disagree → review queue (and these are exactly the
  active-learning samples that move the model most — Tier 4 in
  `02-more-data.md`, brought forward).

### Signal 4 — LLM verification on the transcript

For each candidate, send the transcript window to an LLM with a strict
prompt:

> Given this Mandarin utterance, decide if the speaker has finished
> their turn or is mid-thought. Output exactly `END_OF_TURN` or
> `CONTINUATION`. End-of-turn means the next thing a listener would
> reasonably say is their own response. Continuation means the speaker
> would naturally keep going.

Two text inputs per clip:

- For end-of-turn candidates: the full last-utterance transcript.
- For continuation candidates: the truncated transcript up to the cut
  point.

The LLM is the only signal that sees *language structure* (final
particles 吗/呢/吧/啊, sentence-final intonation cues encoded in
punctuation, syntactic completeness). It catches the case where RAMC
structure says "speaker switched" but the prior speaker actually got
cut off mid-clause.

## Consensus & routing

Per-clip decision:

```
structural   own_model    llm        →  action
-------------------------------------------------------
agree        agree        agree      →  auto-accept, ship to platform as labeled
agree        agree        disagree   →  review queue (LLM caught a possible error)
agree        disagree     agree      →  review queue (high-value: model is wrong here)
agree        disagree     disagree   →  review queue (structural label likely wrong)
filter hit   *            *          →  auto-reject, do not ship
```

Auto-accepted clips still surface in the platform as "auto-labeled,
unconfirmed" so a human reviewer can audit a sample. The review queue
is the primary labeling backlog.

## Filters (auto-reject, no review)

- Utterance contains `[+]` (overlap) — RAMC diarization is unreliable
  on overlap.
- Utterance contains `[*]` for > 30% of its duration (unintelligible).
- Utterance shorter than 200 ms (likely fillers like `嗯`, `啊` —
  ambiguous on their own; keep them only as part of a longer parent
  turn).
- Speaker `G00000000` (RAMC's "noise/non-speech" speaker, e.g.
  `[SONANT]`).
- VAD shows no clear silence boundary within ±300 ms of the structural
  boundary.
- Clip duration outside 1–8 s.

## Pipeline shape (notebook plan)

Keep the existing `wavekat-turn/training/smart-turn-zh/notebooks/`
shape — it already covers ASR + VAD + grouping for AliMeeting. We add
RAMC-specific notebooks under `notebooks/smart-turn-mining/` (sibling
of `notebooks/smart-turn/`, per the placement note in
`02-more-data.md`):

```
notebooks/smart-turn-mining/
├── 01_parse_ramc.ipynb              # TXT → structured utterance table
├── 02_vad_full_sessions.ipynb       # Silero VAD on all session WAVs
├── 03_build_candidates.ipynb        # apply structural rules + VAD trim
├── 04_score_own_model.ipynb         # current zh checkpoint over candidates
├── 05_score_llm.ipynb               # LLM verdict per candidate
├── 06_consensus_route.ipynb         # combine signals, split accept/review
└── 07_submit_to_platform.ipynb      # wavekat-platform Python SDK upload
```

Each notebook follows `notebooks/CLAUDE.md`: banner first cell, title
second cell, every code cell ends with a `print("✅ ...")` line.

Output schema matches `wk exports adapt smart-turn` so the existing
training notebooks (`smart-turn/02_a_train_baseline.ipynb`,
`02_b_train_specaugment.ipynb`) consume the mined data unchanged —
that's a hard constraint from `02-more-data.md`.

## Platform submission

`07_submit_to_platform.ipynb` posts auto-accepted and review-queue
clips to a new wavekat-platform project (working name:
`smart-turn-zh-mining-v1`) via the new Python SDK. Each record
carries:

- The clip WAV (1–8 s, 16 kHz mono).
- The transcript window (raw + punctuated).
- Structural label, own-model prediction + prob, LLM verdict.
- Source session ID, speaker ID, RAMC `[start, end]`.
- Routing tag: `auto_accept` or `needs_review`.

Review UI lets a human confirm / flip the label. Confirmed labels feed
the next training run; rejected clips are dropped (and their
disagreement pattern logged so we can audit the rules).

## Calibration before bulk mining

Per `02-more-data.md`'s "validate before scaling" rule:

1. Run the full pipeline on the **first 5 sessions** only.
2. Audit 200 auto-accepted clips by ear.
3. If per-class label correctness ≥ 95%, scale to the full 349
   sessions.
4. If 90–95%, tighten gap / VAD / filter thresholds and re-audit.
5. If < 90%, the structural rule is wrong somewhere — pause and
   investigate before generating more.

## Expected yield

Rough estimate: 349 sessions × ~150 turns/session = ~52K candidate
boundaries. After overlap / unintelligible / VAD-trim filters
(~ 30% drop) and consensus gating, **~25–35K auto-accepted clips +
~5K review-queue clips**. That alone clears the v1 train target
(5K) by 5×, and makes the test-set bottleneck (Tier 3 human labels on
real wavekat traffic) the next thing to fix.

## Open questions

- Does RAMC's word-level timestamp granularity (10 ms frames per the
  AliMeeting reference, unconfirmed for RAMC) suffice for clean cut
  points, or do we need to re-run Paraformer-zh + ct-punc to get
  per-word timing? **Action:** spot-check 20 sessions before
  committing.
- Which LLM call shape: batched local (Qwen2.5-7B-Instruct via vLLM)
  or hosted? Local is cheaper at this volume; hosted is faster to
  prototype. Default: prototype with hosted, switch to local before
  full 349-session run.
- Do we keep the `[LAUGHTER]` / `[SONANT]` clips? They're real
  conversational signals but rare — hold them out as a stratified
  sub-bucket rather than mixing into the main pool.

## Exit criteria

- ≥ 5K auto-accepted training clips with per-class noise ≤ 5%
  (audited).
- ≥ 1K clips in the review queue, surfaced in the wavekat-platform
  project.
- Mining-only baseline (same hyperparameters as
  `02_a_train_baseline`) trains without F1 collapse on the existing
  human test set — sanity check that the mined distribution is
  learnable before mixing.
