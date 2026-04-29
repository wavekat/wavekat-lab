# Plan: Turn Detection in wavekat-lab

**Status:** Shipped in v0.0.4 (PR [#8](https://github.com/wavekat/wavekat-lab/pull/8)) — multi-config Pipecat. LiveKit text-turn still deferred.
**Date:** 2026-03-28

---

## Design principle

wavekat-lab exists to compare backends side-by-side. VAD runs N configs simultaneously
and renders N probability timelines. Turn detection must follow the exact same pattern —
a list of named configs, each selecting a backend and its parameters, with one result
timeline per config.

The current implementation (single hardcoded Pipecat card, `SetTurnConfig` message,
no config_id on results) was a shortcut that breaks this model. This document describes
what it should be.

---

## Backend split: audio vs text

`wavekat-turn` provides two distinct detector families:

| Family | Trait | Input | Backends |
|--------|-------|-------|----------|
| Audio | `AudioTurnDetector` | 16 kHz PCM frames | `pipecat` (Smart Turn v3) |
| Text | `TextTurnDetector` | ASR transcript | `livekit` (Turn Detector) |

These cannot share a pipeline — audio backends slot into the existing frame-streaming
architecture, while text backends require a transcript input that has no equivalent today.

**Scope for this plan: audio turn detection only.**
Text turn detection is deferred (requires a separate transcript input path).

---

## Current state (what was built)

### Backend (Rust)

- `run_turn_pipeline(audio_tx, sample_rate, predict_every_frames)` — single instance,
  no config_id, fixed backend (always Pipecat)
- `SetTurnConfig { predict_every_frames }` — single scalar, no config identity
- `TurnResult { timestamp_ms, state, confidence, latency_ms }` — no config_id
- `Turn { ... }` server message — no config_id

### Frontend (TypeScript)

- `TurnConfigPanel` — single fixed card, no add/remove/clone, backend selector absent
- `turnConfig: TurnConfig` — single object, not a list
- `turnResults: TurnResultPoint[]` — flat array, not keyed by config
- `TurnTimeline` — no config_id prop, single timeline

### What's wrong

- Can't run multiple turn configs simultaneously
- Can't compare Pipecat at 200 ms vs 500 ms interval
- Can't add a second audio backend later without rearchitecting
- Inconsistent with VAD UX — users expect the same add/remove/clone pattern

---

## Target state

### Config shape

```typescript
interface TurnConfig {
  id: string;
  label: string;
  backend: "pipecat";        // only audio backends for now
  params: Record<string, unknown>;
}
```

Pipecat params:
- `predict_every_frames: number` — how many 10 ms audio frames between predictions

Future audio backends (e.g. a second model) just add to the `backend` union and their
params to the backend registry, exactly like adding a new VAD backend.

### Backend changes

**`pipeline.rs`**
- `run_turn_pipeline` takes `configs: &[TurnConfig]` (plural), spawns one async task per
  config — mirrors `run_pipeline` for VAD exactly.
- `TurnResult` gains `config_id: String`.
- `create_turn_detector(config)` factory — returns `Box<dyn AudioTurnDetector>`.
  Currently only `"pipecat"` is wired; unknown backends log an error and are skipped.
- `available_turn_backends()` — returns `HashMap<String, Vec<ParamInfo>>` for the
  frontend config panel to enumerate (same pattern as `available_backends()` for VAD).

**`ws.rs`**
- `SetTurnConfigs { configs: Vec<TurnConfig> }` replaces `SetTurnConfig`.
- `Turn { config_id, timestamp_ms, state, confidence, latency_ms }` — config_id added.
- `ListTurnBackends` client message → `TurnBackends { backends }` server message.
  (Or fold into the existing `ListBackends` / `Backends` pair — TBD.)
- `handle_ws` tracks `turn_configs: Vec<TurnConfig>` state, same as `configs` for VAD.

**`session.rs`** (optional, low priority)
- Add `TurnConfig` to the session model alongside `VadConfig` for save/load.

### Frontend changes

**`TurnConfigPanel.tsx`**
- Mirrors `ConfigPanel.tsx` structurally: same add/remove/clone buttons, same card-per-
  config grid, same label-editing pattern.
- Backend selector shows available audio turn backends (fetched via `list_turn_backends`
  or folded into `list_backends`).
- Params rendered dynamically from `ParamInfo[]` — same rendering logic as VAD params.
- No preprocessing section (turn detectors do not have preprocessing configs).

**`TurnTimeline.tsx`**
- Gains `configId` and `label` props, matching `VadTimeline`.
- Rendered once per config, same as `VadTimeline`.

**`websocket.ts`**
- `set_turn_configs` replaces `set_turn_config` (plural, list).
- `turn` server message gains `config_id`.

**`App.tsx`**
- `turnConfigs: TurnConfig[]` replaces `turnConfig: TurnConfig`.
- `turnResults: Record<string, TurnResultPoint[]>` replaces flat array (keyed by config_id).
- Sends `set_turn_configs` before `start_recording` / `load_file`, same timing as
  `set_configs` for VAD.
- Renders one `TurnTimeline` per config below the VAD timelines.

---

## What stays different from VAD (intentionally)

| | VAD | Audio Turn |
|---|---|---|
| Multi-instance | Yes | Yes (after this plan) |
| Preprocessing | Yes (HPF, denoise, normalize) | No — model consumes raw 16 kHz |
| Show preprocessed waveform | Yes | No |
| Backend source | `wavekat-vad` | `wavekat-turn` |
| Section label | "VAD Configurations" | "Turn Detection" |

The two config panels remain separate components with separate section headers so the
crate boundary is visible in the UI.

---

## Out of scope for this plan

- **Text turn detection (LiveKit)** — requires a separate transcript input path that
  doesn't exist yet. Tracked in `01-plan-general-lab.md` Phase 4.
- **Model download infrastructure** — Pipecat model is embedded at build time via the
  existing `wavekat-turn` build script. Runtime lazy download is a future improvement
  (see `01-plan-general-lab.md` Phase 2).
- **Pipeline mode** — auto-feeding VAD speech events into turn detector. Tracked in
  `01-plan-general-lab.md` Phase 5.

---

## Implementation order

1. **Backend** — `TurnConfig` struct, `run_turn_pipeline` accepting a list, config_id
   on results, `available_turn_backends()`, updated WS messages.
2. **Frontend types** — update `websocket.ts` (plural message, config_id on Turn).
3. **TurnConfigPanel** — refactor to full add/remove/clone list, dynamic param rendering.
4. **App.tsx** — `turnConfigs[]`, `turnResults` keyed by config_id, multi-timeline render.
5. **Build + test** — verify multiple Pipecat configs run simultaneously with different
   intervals and produce separate timelines.
