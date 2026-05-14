# 05 — Plan: Live ASR in audio-lab

**Status:** Draft
**Date:** 2026-05-15
**Branch:** `feat/asr-integration`

---

## Goal

Wire [`wavekat-asr`](https://github.com/wavekat/wavekat-asr) into `tools/audio-lab`
so the existing VAD / Turn / Pipeline timelines pick up a fourth result layer:
live streaming transcripts. The lab should let a user pick a recording (mic or
WAV) and watch partials roll in as the audio plays — same fan-out pattern as
the existing backends, just emitting text instead of probabilities.

This mirrors how VAD and Turn already work: one config type, one runner spawned
per active config, results fanned back out over the WebSocket. ASR is the next
backend slot, not a new lab.

---

## What "see the live ASR" means

Three visible surfaces in the UI:

1. **AsrConfigPanel** — pick backend (`sherpa-onnx`), pick model preset
   (`bilingual` / `en` / `zh` / `paraformer-zh-en`), give it a label. Same shape
   as `TurnConfigPanel`.
2. **AsrTranscript** panel — per-config rolling transcript. Partials render in
   muted color and overwrite the last partial; finals commit to a stable line
   with `[ts–end ms]` prefix. Multiple configs stack so you can A/B model
   presets side by side on the same audio.
3. **Transcript ticks on the timeline** — small marks on the existing VAD /
   Pipeline timeline at each `Final` event so transcripts line up visually with
   VAD speech segments and pipeline EOU predictions. (Optional in v1, see Cut
   lines.)

No new full-page route; ASR is a tab next to VAD / Turn / Pipeline in the
existing config sidebar.

### Layout sketch

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Device ▾ MacBook Mic]  [● Record]  [Upload WAV]   ws ●connected      [Zoom]│
├───────────────────────┬──────────────────────────────────────────────────────┤
│  VAD Configs    [+]   │  Waveform   ████▆▅▃▂▁▁▂▃▅▇████▆▄▂▁ ▁▂▄▆██▆▃▁         │
│  ▸ webrtc-aggressive  │  Spectrum   ▒▒▓▓██▓▓▒▒░░ … (FFT bins)                │
│  ▸ silero-0.5         │                                                      │
│                       │  VAD          ─/‾\─/‾‾\__/‾‾‾\___                    │
│  Turn Configs   [+]   │  Turn         ·   ·F   ·U  ·F                        │
│  ▸ pipecat-500ms      │  Pipeline     │start───────end (finished 87%)│       │
│                       │                                                      │
│  Pipeline       [+]   │  ┌─ ASR: sherpa-onnx · bilingual ──── copy all ─┐    │
│  ▸ silero→pipecat     │  │ [00:01.2–00:03.4]  hello there how are you   │    │
│                       │  │ [00:04.0–00:07.1]  我今天有点忙               │    │
│  ▼ ASR Configs  [+]   │  │ [00:08.5–00:10.2]  let me check the schedule │    │
│  ▸ sherpa · bilingual │  │   partial: …i'm running a bit late          │    │
│  ▸ sherpa · zh (off)  │  │                                              │    │
│    Backend  [sherpa▾] │  │  conf 0.92  · 14 finals · 1.3s avg latency  │    │
│    Preset   [biling▾] │  └──────────────────────────────────────────────┘    │
│    Label   [my-test ] │                                                      │
│                       │  ┌─ Log ────────────────────────────────────────┐    │
│                       │  │ 10:14:02 recv  asr [sherpa] partial "…late"  │    │
│                       │  │ 10:14:03 recv  asr [sherpa] final "…late"    │    │
│                       │  └──────────────────────────────────────────────┘    │
└───────────────────────┴──────────────────────────────────────────────────────┘
```

Key behaviors:

- **AsrConfigPanel** sits next to the VAD/Turn/Pipeline panels — same affordances
  (add, label, enable, delete). Two params for now: backend dropdown (just
  `sherpa-onnx`) and preset dropdown (`bilingual` / `en` / `zh` /
  `paraformer-zh-en`).
- **AsrTranscript card** renders one card per active ASR config, stacked. Each
  card has committed finals (one per line with `[ts–end]` prefix) and a single
  dimmed trailing line for the live partial that gets overwritten until it
  commits as a final.
- **Multi-config A/B** — running two configs gives two cards stacked, so you
  can compare `bilingual` vs `zh` on the same audio.
- **Cold-start** — first record after pulling shows `loading model…` in the
  card body (just a status line, no separate spinner UI). After the ~75 MB HF
  download, subsequent runs are instant.
- **Footer of each card** — confidence of the latest final, count of finals,
  average latency. Cheap stats; no fancy chart.

---

## Backend changes (`tools/audio-lab/backend`)

### Cargo.toml

```toml
wavekat-asr = { version = "0.0.3", features = ["sherpa-onnx"] }
```

First run downloads the bilingual EN+ZH Zipformer (~75 MB) into `$HF_HOME`.
Document this in `tools/audio-lab/README.md` under a new "ASR" section so the
first `cargo run` after pulling doesn't look hung.

### New module: `backend/src/asr.rs`

```rust
pub struct AsrConfig {
    pub id: String,
    pub label: String,
    pub backend: String,         // "sherpa-onnx"
    pub params: HashMap<String, serde_json::Value>,  // {"preset": "bilingual"}
}

pub enum AsrServerEvent {
    SpeechStarted { config_id, ts_ms },
    SpeechEnded   { config_id, ts_ms },
    Partial       { config_id, ts_ms, text },
    Final         { config_id, ts_ms, end_ms, text, confidence },
    Warning       { config_id, message },
}

pub fn run_asr_pipeline(
    configs: &[AsrConfig],
    audio_tx: &broadcast::Sender<AudioFrame>,
    sample_rate: u32,
) -> mpsc::Receiver<AsrServerEvent>;
```

Per-config task does:

1. Build the backend at construction time (`SherpaOnnxAsr::with_preset(preset)`).
   Construction blocks on model load; do it inside `tokio::task::spawn_blocking`
   so we don't stall the websocket select loop on first run while HF downloads.
2. Subscribe to `audio_tx`. For each frame:
   - Convert `Vec<i16>` → `Vec<f32>` (`s as f32 / i16::MAX as f32`).
   - Resample to 16 kHz if `sample_rate != 16000`. Reuse `pipeline::resample_linear`
     after we widen it to f32, OR pull in `wavekat-core` with the `resample`
     feature and use `CoreAudioFrame::resample` — the example `transcribe_mic.rs`
     does this. Decision below.
   - `asr.push_audio(&frame, Channel::Local)`.
3. Poll the backend's `std::sync::mpsc::Receiver<TranscriptEvent>` after each push
   (the receiver is the synchronous one returned at construction). Bridge each
   event into the tokio `AsrServerEvent` mpsc.
4. On `audio_rx.recv()` returning `Err` (broadcast closed) → call `asr.finish()`
   to flush, drain the receiver one last time, return.

**Resampling decision: reuse `wavekat-core` resample.** The audio-lab backend
already targets the same crate ecosystem and `transcribe_mic.rs` is the
upstream-blessed shape. Linear-interp resampling is acceptable for VAD but ASR
WER suffers measurably from naive resampling — opt into the real one.

**Drain via `try_iter()`** after each push to avoid blocking the audio loop on
the sync receiver.

**Why no `Channel::Remote`?** Audio-lab today has one channel (mic or single
WAV channel). Always send `Channel::Local`. Two-channel support can land later
if/when audio-lab grows it.

### `ws.rs`

Add to `ClientMessage`:

```rust
ListAsrBackends,
SetAsrConfigs { configs: Vec<AsrConfig> },
```

Add to `ServerMessage`:

```rust
AsrBackends { backends: HashMap<String, Vec<ParamInfo>> },
Asr {
    config_id: String,
    kind: String,         // "speech_started" | "speech_ended" | "partial" | "final" | "warning"
    ts_ms: f64,
    end_ms: Option<f64>,  // only on `final`
    text: Option<String>, // partial / final / warning
    confidence: Option<f32>,
},
```

Both `StartRecording` and `LoadFile` branches: spawn `run_asr_pipeline` next to
the existing `run_pipeline` / `run_turn_pipeline` calls. Forward
`AsrServerEvent`s into the existing `msg_tx` channel as `ServerMessage::Asr` —
same shape as the turn / pipeline forwarders we already have.

Construction cost matters: building `SherpaOnnxAsr` on the hot path of
`StartRecording` would freeze the websocket. Two options:

1. **Lazy + cached.** Keep a `HashMap<(backend, preset), SherpaOnnxAsr>` on the
   session. First time a config references a preset, build it inside
   `spawn_blocking` and cache. Resets on disconnect.
2. **Eager prebuild.** On `SetAsrConfigs`, kick off `spawn_blocking` to build
   any new (backend, preset) and send an `AsrReady { config_id }` server message
   before `StartRecording` is even allowed.

Pick **(1)**. Simpler state, matches how VAD detectors are built on demand
inside `run_pipeline`. The user's feedback loop is "press record → first frame
in → asr lags a few seconds on cold start" — acceptable for the lab, the same
warning already exists for VAD with Silero's first-run model download.

---

## Frontend changes (`tools/audio-lab/frontend`)

### `lib/websocket.ts`

Mirror the server types:

```ts
export interface AsrConfig {
  id: string;
  label: string;
  backend: string;
  params: Record<string, unknown>;  // {preset: "bilingual"}
}

export type AsrEventKind =
  | "speech_started" | "speech_ended" | "partial" | "final" | "warning";

// ServerMessage:
| { type: "asr_backends"; backends: Record<string, ParamInfo[]> }
| {
    type: "asr";
    config_id: string;
    kind: AsrEventKind;
    ts_ms: number;
    end_ms?: number;
    text?: string;
    confidence?: number;
  }

// ClientMessage:
| { type: "list_asr_backends" }
| { type: "set_asr_configs"; configs: AsrConfig[] }
```

Batch-summarize `asr` partials in `addToBatch` the same way `vad` is summarized,
so the log panel doesn't drown in partials.

### New components

- `components/AsrConfigPanel.tsx` — copy of `TurnConfigPanel.tsx`, swap the
  backend + param surface. Single preset dropdown for now.
- `components/AsrTranscript.tsx` — for each active config, render a card:
  - Header: config label, latest `[ts–end]` range.
  - Body: scrollable list of finals (committed) + a dimmed trailing line for
    the current partial. Auto-scroll to bottom unless user has scrolled up.
  - Tail action: copy-all-finals button.
- Optional v2: transcript ticks on `VadTimeline` / `PipelineTimeline` at each
  `final` event. Out of scope for first PR; ship the standalone panel first.

### `App.tsx`

- Add `asrConfigs` / `setAsrConfigs` state alongside `turnConfigs`.
- Add `asrTranscripts: Record<configId, { finals: Final[]; partial: string | null }>`
  state, updated from the `asr` ServerMessage handler.
- Send `list_asr_backends` on connect (alongside `list_backends` /
  `list_turn_backends`).
- Send `set_asr_configs` whenever `asrConfigs` changes.
- Reset transcript state on `recording_started` and on `done`.
- Render `<AsrConfigPanel>` in the sidebar and `<AsrTranscript>` in the main
  column under the existing timelines.

---

## Cut lines

What's intentionally out of scope for the first PR:

- **Two-channel ASR.** Single `Channel::Local` only.
- **Per-config preprocessing** (denoise / HPF before ASR). VAD has it; ASR
  doesn't need it for v1 — sherpa-onnx already has its own front-end.
- **Transcript timeline ticks.** Cool but not load-bearing. Standalone panel
  is enough to claim "live ASR works."
- **Confidence visualization.** Show as a number on the final line; no
  heatmap.
- **WER / latency benchmarking.** No comparison table yet. We'll add one when
  a second backend lands (matching VAD's benchmark surface).
- **Persisting transcripts to disk.** Session save/load already only handles
  VAD; bringing ASR into the session schema is a follow-up.
- **Hot-swap of preset without re-record.** Changing a preset requires stopping
  + restarting the recording. Same as VAD backends today.

---

## Risk / open questions

1. **Cold-start model download.** First `SherpaOnnxAsr::new()` blocks for tens
   of seconds while the model downloads. The websocket session must not hang —
   `spawn_blocking` handles it, but the frontend needs a visible "loading
   model…" state. Reuse the existing log panel hint, or surface a new
   `AsrReady` event? Decide during implementation.
2. **Resample quality vs. crate footprint.** Pulling `wavekat-core` with
   `resample` adds another dep + compile time. The `transcribe_mic` example
   already validates this path so the risk is small, but worth confirming the
   compile-time hit before merging.
3. **Backpressure.** `transcribe_mic.rs` pushes audio synchronously and drains
   after every push. Audio-lab's broadcast can buffer a lot of frames if ASR
   stalls — the broadcast already drops on lag, which is correct for a lab
   tool (we want fresh audio, not a backlog). Confirm the lag-drop mode is
   what we want; switch to bounded mpsc per-config if not.
4. **Frame size from broadcast.** The session emits 10 ms frames at the device
   sample rate. Sherpa-onnx accepts any frame size — no work needed — but
   verify with a long recording that we don't introduce per-frame latency
   hot-spots.

---

## Milestones

1. **M1 — Backend wired.** `wavekat-asr` dep added, `asr.rs` module, ws
   messages, `cargo run` prints transcripts to logs when an asr config is set.
   No frontend.
2. **M2 — Frontend transcript panel.** `AsrConfigPanel` + `AsrTranscript` ship.
   `make dev` end-to-end gives a live transcript card for the chosen preset.
3. **M3 — Polish.** Loading state for cold-start, log-panel batching for
   partials, README "ASR" section, screenshot in the lab README's video table
   (or a short Loom). Cut a `v0.0.x` release of audio-lab.

Each milestone is one PR. Plan doc is M0.
