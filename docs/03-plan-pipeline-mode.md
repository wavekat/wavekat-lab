# Plan: Pipeline Mode — VAD-Gated Turn Detection

**Status:** Planning
**Date:** 2026-03-29

---

## Problem

VAD and Turn detection currently run in parallel but independently. Turn's Pipecat model
predicts on a fixed interval (e.g., every 500 ms) regardless of speech activity. This does
not reflect real production usage, where the flow is:

```
Audio → VAD → speech segment ends → TurnDetector.predict() → EOU decision
```

The lab should support this coupled mode so users can observe how VAD speech boundaries
drive turn detection, not just how each model behaves in isolation.

---

## Design principle

A **PipelineConfig** links an existing VAD config to an existing Turn config. It does not
replace them — both configs still run independently and their existing timelines remain. The
pipeline config adds a third result layer: VAD-gated turn predictions at speech boundaries.

This makes it easy to compare:
- Turn at fixed interval (existing behavior) vs. Turn at VAD speech end (new behavior)
- Same Turn config paired with different VAD backends
- Same VAD backend paired with different Turn configs

---

## New config type

```typescript
interface PipelineConfig {
  id: string;
  label: string;
  vad_config_id: string;          // references an existing VadConfig by id
  turn_config_id: string;         // references an existing TurnConfig by id
  speech_end_threshold: number;   // VAD probability below this = speech ended (e.g. 0.3)
  speech_start_threshold: number; // VAD probability above this = speech started (e.g. 0.5)
  min_silence_ms: number;         // silence must hold for this long before firing (e.g. 300 ms)
}
```

**Defaults:**
- `speech_end_threshold`: 0.3
- `speech_start_threshold`: 0.5
- `min_silence_ms`: 300

The `vad_config_id` and `turn_config_id` are selectors from the currently active configs.
The pipeline config is invalid (and ignored by the backend) if either referenced config does
not exist.

---

## Coupled behavior

```
VAD (config A)           probability output
                              ↓
                         PipelineRunner
                         ┌────────────────────────────────┐
                         │ speech_started = false          │
                         │                                 │
                         │  prob > speech_start_threshold  │
                         │  → speech_started = true        │
                         │  → Turn.reset()                 │
                         │  → begin feeding audio to Turn  │
                         │                                 │
                         │  prob < speech_end_threshold    │
                         │  held for min_silence_ms        │
                         │  → Turn.predict()               │
                         │  → emit PipelineResult          │
                         │  → speech_started = false       │
                         └────────────────────────────────┘

Turn (config B)          audio frames (same as always, but reset + predict controlled externally)
```

The Turn detector referenced by the pipeline config is shared with the normal Turn pipeline.
It receives audio frames via the normal broadcast channel. What changes is:
- `reset()` is called at each detected speech start
- `predict()` is called at each detected speech end (instead of, or in addition to, the
  fixed-interval prediction)

> **Note:** This means if a Turn config is linked in a PipelineConfig, its fixed-interval
> predictions continue AND it also gets triggered at speech boundaries. The speech-boundary
> predictions are tagged as such in the result so the frontend can distinguish them.

---

## Backend changes

### `pipeline.rs`

**New struct:**

```rust
pub struct PipelineConfig {
    pub id: String,
    pub label: String,
    pub vad_config_id: String,
    pub turn_config_id: String,
    pub speech_end_threshold: f32,
    pub speech_start_threshold: f32,
    pub min_silence_ms: u32,
}
```

**New result:**

```rust
pub struct PipelineResult {
    pub config_id: String,
    pub timestamp_ms: f64,
    pub event: PipelineEvent,
}

pub enum PipelineEvent {
    SpeechStart,
    SpeechEnd {
        turn_state: String,       // "finished", "unfinished", "wait"
        turn_confidence: f32,
        turn_latency_ms: u64,
    },
}
```

**New runner:**

```rust
pub fn run_pipeline_mode(
    pipeline_configs: &[PipelineConfig],
    vad_result_rx: broadcast::Receiver<PipelineResult>,  // VAD output stream
    turn_detectors: &HashMap<String, Arc<Mutex<dyn AudioTurnDetector>>>,
) -> mpsc::Receiver<PipelineResult>
```

The runner subscribes to VAD results (already computed by the normal VAD pipeline). For each
VAD result it receives, it checks if any PipelineConfig references that VAD config's id, then
applies the threshold state machine.

To share Turn detectors between the normal Turn pipeline and the pipeline runner, each Turn
detector is wrapped in `Arc<Mutex<...>>`. The Turn pipeline and pipeline runner both hold a
clone of the Arc.

### `ws.rs`

**New client messages:**
```
SetPipelineConfigs { configs: Vec<PipelineConfig> }
```

**New server messages:**
```
Pipeline {
    config_id: String,
    timestamp_ms: f64,
    event: String,           // "speech_start" or "speech_end"
    turn_state: Option<String>,
    turn_confidence: Option<f32>,
    turn_latency_ms: Option<u64>,
}
```

`handle_ws` tracks `pipeline_configs: Vec<PipelineConfig>` and restarts the pipeline runner
when configs change (same pattern as VAD and Turn).

### `session.rs`

Add `PipelineConfig` alongside `VadConfig` and `TurnConfig`.

---

## Frontend changes

### New types (`websocket.ts`)

```typescript
interface PipelineConfig {
  id: string;
  label: string;
  vad_config_id: string;
  turn_config_id: string;
  speech_end_threshold: number;
  speech_start_threshold: number;
  min_silence_ms: number;
}

type PipelineEvent =
  | { event: "speech_start" }
  | { event: "speech_end"; turn_state: string; turn_confidence: number; turn_latency_ms: number };

interface PipelineResultPoint {
  timestamp_ms: number;
  event: string;
  turn_state?: string;
  turn_confidence?: number;
  turn_latency_ms?: number;
}
```

New client message: `set_pipeline_configs`.
New server message: `pipeline` → dispatched to App state.

### `PipelineConfigPanel.tsx`

New component for creating and editing pipeline configs.

Each card shows:
- **Label** — inline editable
- **VAD Config** — dropdown of current `configs` (by label)
- **Turn Config** — dropdown of current `turnConfigs` (by label)
- **Speech start threshold** — float input (0.0–1.0, default 0.5)
- **Speech end threshold** — float input (0.0–1.0, default 0.3)
- **Min silence** — int input in ms (default 300)
- Clone / Remove buttons

"Add Pipeline" button appends a new card with defaults. If no VAD or Turn configs exist, the
panel shows an inline note: _"Add at least one VAD config and one Turn config first."_

### `PipelineTimeline.tsx`

New canvas-based timeline component. Renders over the same time axis as VAD and Turn timelines.

**What it shows:**

```
┌─────────────────────────────────────────────────────┐
│ My Pipeline (WebRTC → Pipecat)                       │
│                                                      │
│ ░░░▓▓▓▓▓▓▓▓▓▓░░░░░░▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░  │
│            ↑              ↑                          │
│         finished        unfinished                   │
└─────────────────────────────────────────────────────┘
```

- **Speech segments** — a shaded band from `speech_start` to `speech_end` event timestamps
- **Prediction bubble** — at the right edge of each speech segment, a colored dot (using
  same `STATE_COLORS` as `TurnTimeline`) with a label: `finished 92% · 11ms`
- **Height** — fixed 48 px (slightly taller than VAD/Turn timelines at 32 px, to accommodate
  the speech band + prediction dot)

Hover shows the full event details.

### `App.tsx`

**New state:**
```typescript
const [pipelineConfigs, setPipelineConfigs] = useState<PipelineConfig[]>([]);
const [pipelineResults, setPipelineResults] = useState<Record<string, PipelineResultPoint[]>>({});
```

**New section: "Pipeline Mode"** (collapsible, below the Turn Detection section)

Rendering order:
1. Waveform
2. Spectrogram
3. VAD timelines (one per VAD config)
4. Turn timelines (one per Turn config)
5. **Pipeline timelines** (one per PipelineConfig) ← new

Config panels (below visualization):
1. VAD Configurations
2. Turn Detection
3. **Pipeline Mode** ← new

**LocalStorage:**
- Key: `"lab-pipeline-configs"` — saved on every change, same pattern as VAD configs.
- No default pipeline configs on first visit (unlike VAD, there's no sensible default without
  knowing what VAD/Turn configs the user has created).

---

## Combined display example

When the user has:
- VAD: `WebRTC VAD` (id: `cfg-1`)
- Turn: `Pipecat 500ms` (id: `tcfg-1`)
- Pipeline: `My Pipeline` → links `cfg-1` → `tcfg-1`

The timeline section looks like:

```
Waveform     ─────────────────────────────────────────────────
Spectrogram  ─────────────────────────────────────────────────

[VAD]
WebRTC VAD   ░░░▓▓▓▓▓▓▓▓▓░░░░░░░▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░

[Turn]
Pipecat 500ms  ░░░██░░░███░░░░░░░██████░░░░░░░░░░░░░░░░░░░░░░
               (fixed-interval predictions every 500 ms)

[Pipeline]
My Pipeline  ───[speech]──●──────[speech]──●─────────────────
                       finished          unfinished
```

The pipeline timeline makes it easy to read: "at the end of that speech segment, the turn
model said `finished` with 92% confidence."

---

## Relationship to existing Turn timelines

Pipeline mode does **not** replace the Turn timeline. The Turn timeline continues to show all
predictions (fixed-interval + VAD-triggered). The pipeline timeline shows only the
VAD-triggered predictions, framed within speech segments.

A user who wants to understand the difference between interval-based and VAD-gated behavior
can observe both timelines side-by-side.

---

## Out of scope for this plan

- **Automatic speech segment export** — clipping the audio of each speech segment for replay.
  Useful but separate feature.
- **Multiple VAD configs gating the same Turn config** — the first `PipelineConfig` that
  references a given Turn config wins. Running two VAD backends against one Turn detector
  simultaneously would cause interleaved reset/predict calls; this requires a queuing layer
  not designed here.
- **Text turn detection** — no transcript input path exists yet (see `01-plan-general-lab.md`).
- **Confidence threshold on Turn** — some users may want to only surface predictions above a
  confidence threshold. Deferred; the raw predictions are always shown.

---

## Implementation order

1. **`session.rs`** — Add `PipelineConfig` struct (Rust). No logic yet.
2. **`ws.rs`** — Add `SetPipelineConfigs` client message and `Pipeline` server message.
   Track `pipeline_configs` state in `handle_ws`.
3. **`pipeline.rs`** — Implement `run_pipeline_mode`. Start with a simple version: no
   `min_silence_ms` debounce, just threshold crossing. Add debounce in a follow-up.
   Requires Turn detectors to be `Arc<Mutex<...>>` shared between normal pipeline and
   pipeline runner.
4. **`websocket.ts`** — Add `PipelineConfig` type, `set_pipeline_configs` message, `pipeline`
   server message parsing.
5. **`PipelineConfigPanel.tsx`** — Config editor with VAD/Turn dropdowns. Add/remove/clone.
6. **`PipelineTimeline.tsx`** — Canvas timeline: speech bands + prediction dots.
7. **`App.tsx`** — Wire new state, new section in visualization, new section in config panel,
   localStorage persistence.
8. **Build + test** — Verify with a recording: speech detected → Turn reset → prediction fires
   at speech end → appears in pipeline timeline.
