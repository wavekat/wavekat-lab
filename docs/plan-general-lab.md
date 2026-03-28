# Plan: Generalize wavekat-lab for VAD + Turn Detection Testing

**Status:** In progress
**Date:** 2026-03-28

---

## Decisions made

- **Rename done.** `tools/vad-lab/` → `tools/lab/`, Cargo package `vad-lab` → `lab`. All
  references updated. Build verified clean.
- **Single unified tool** (Option B). One Axum + React app with VAD and Turn sections. Shared
  audio capture, waveform display, and WebSocket infrastructure.
- **Sequencing.** Rename first (done), verify VAD still works, then add turn detection.

---

## Background

`wavekat-lab` contained a single tool, `vad-lab`, for testing VAD backends from `wavekat-vad`.
As `wavekat-turn` enters active development (v0.0.1), we are expanding the lab into a general
testing tool for all wavekat-* library backends.

---

## What exists today

### lab (tools/lab) — formerly vad-lab

**Backend (Rust/Axum):**
- Accepts audio from microphone (cpal) or WAV file upload
- Fans audio to N parallel VAD configs (each with its own preprocessing: HPF, RNNoise, normalization)
- Streams results over WebSocket: waveform, FFT spectrogram, per-backend VAD probability
- Reports per-backend RTF (real-time factor)

**Frontend (React/TypeScript):**
- Synchronized waveform + spectrogram display
- Side-by-side VAD probability timelines
- Live recording and WAV upload

### wavekat-turn (v0.0.1)

Two backend families:

| Backend | Feature | Input | Model | Inference |
|---------|---------|-------|-------|-----------|
| Pipecat Smart Turn v3 | `pipecat` | Audio frames (16 kHz PCM) | ~8 MB ONNX int8 | ~12 ms CPU |
| LiveKit Turn Detector | `livekit` | ASR transcript text | ~400 MB ONNX | ~25 ms CPU |

Traits:
- `AudioTurnDetector` — `push_audio(frame)` + `predict()` → `TurnPrediction { state, confidence, latency_ms }`
- `TextTurnDetector` — `predict_text(transcript, context)` → `TurnPrediction`

`TurnState`: `Finished` | `Unfinished` | `Wait`

In production the flow is: **Audio → VAD → (speech segment) → TurnDetector → EOU decision**

---

## Proposed structure

```
wavekat-lab/
├── tools/
│   └── lab/
│       ├── backend/
│       │   ├── Cargo.toml
│       │   └── src/
│       │       ├── main.rs
│       │       ├── vad/          # existing VAD fan-out logic
│       │       │   ├── mod.rs
│       │       │   └── pipeline.rs
│       │       └── turn/         # new
│       │           ├── mod.rs
│       │           ├── audio.rs   # AudioTurnDetector runner
│       │           └── text.rs    # TextTurnDetector runner
│       └── frontend/
│           └── src/
│               ├── App.tsx
│               ├── vad/           # existing VAD components
│               └── turn/          # new
│                   ├── AudioTurnPanel.tsx
│                   └── TextTurnPanel.tsx
```

---

## Model download strategy

As more wavekat-* backends are added, models will vary significantly in size (8 MB to 400 MB+)
and there may be many optional variants. Build-time download (current wavekat-vad pattern) does
not scale to this.

### Recommended: runtime lazy download with a shared cache

Models are downloaded on first use to a shared local cache. The lab backend manages this directly
(independent of how the published crates handle it).

**Cache location:**
```
~/.cache/wavekat/models/<model-name>-<version>.<ext>
```
Overridable via `WAVEKAT_MODELS_DIR` env var for CI, offline environments, or custom paths.

**Model manifest** — a static file (e.g. `models.toml` in the backend) listing every model the
lab knows about:
```toml
[[model]]
id       = "pipecat-smart-turn-v3"
filename = "pipecat-smart-turn-v3.onnx"
url      = "https://..."
sha256   = "abc123..."
size_mb  = 8

[[model]]
id       = "livekit-turn-detector"
filename = "livekit-turn-detector.onnx"
url      = "https://..."
sha256   = "def456..."
size_mb  = 400
```

**Download flow:**
1. Backend starts → scans which models are cached
2. When a section of the UI is loaded (e.g. Turn / LiveKit tab), backend checks cache
3. If not cached: streams download to temp file → verifies SHA-256 → moves to cache
4. Backend pushes download progress to frontend via WebSocket
5. Frontend shows a progress bar / "Downloading model (380 MB)..." state before the panel activates

**`make setup-models` target** — pre-downloads all models for offline use:
```makefile
setup-models:
    cargo run -p lab -- download-models --all
```
Can also target specific models:
```bash
cargo run -p lab -- download-models --model pipecat-smart-turn-v3
```

### Why not build-time download (current wavekat-vad pattern)?

Build-time download works for published crates (users expect it, it's one-time per build).
For the lab tool it creates friction:
- 400 MB downloaded on every clean build
- CI must fetch large files every run unless carefully cached
- No way to opt out of models you don't need

The lab is a local dev tool; lazy runtime download with a visible progress UI is a better fit.

### Relationship to published crate download behavior

`wavekat-vad` and `wavekat-turn` as crates still download models at build time via their build
scripts (for library users who just add the crate as a dependency). The lab backend can opt out
of this by pointing the crates' env vars to the shared model cache, avoiding double-downloads:

```bash
# In dev-backend Makefile target or .env:
WAVEKAT_MODELS_DIR=~/.cache/wavekat/models
```

This way a model downloaded once by the lab is reused if the user also compiles against the crate
directly.

---

## Backend API additions (turn endpoints)

```
POST /turn/audio/start       # Start a new AudioTurnDetector session (backend: pipecat)
WS   /turn/audio/stream      # Stream PCM frames; server returns TurnPrediction at each push
POST /turn/audio/predict     # Explicit predict on buffered audio
POST /turn/audio/reset

POST /turn/text/predict      # Body: { transcript, context: [{role, text}] }
                             # Response: TurnPrediction (state, confidence, latency_ms)

GET  /models/status          # Returns { id, cached, size_mb, download_progress } for each model
POST /models/download        # Body: { id }; triggers background download, progress via WS
```

Audio streaming mirrors the existing VAD WebSocket pattern.
Text is a single REST round-trip per prediction.

---

## Frontend additions (turn panels)

**AudioTurnPanel:**
- Record / play audio (reuse existing audio input component)
- Show `TurnState` indicator (color-coded: green=Finished, yellow=Unfinished, orange=Wait)
- Show confidence bar + latency badge
- Timeline: per-frame prediction history plotted over the waveform

**TextTurnPanel:**
- Transcript textarea + optional conversation context editor (`[User] ... [Assistant] ...`)
- "Predict" button → calls `/turn/text/predict`
- Shows `TurnState`, confidence, latency
- History table of past predictions

**Model status widget (shared):**
- Small indicator per backend showing: cached / downloading (progress %) / not downloaded
- "Download" button for uncached models
- Surfaced in both VAD and Turn sections for any neural backends

---

## Cargo.toml additions (backend)

```toml
[dependencies]
# existing
wavekat-vad = { version = "0.1", features = ["webrtc", "silero", "ten-vad", "firered", "denoise", "serde"] }

# new
wavekat-turn = { version = "0.0", features = ["pipecat", "livekit"] }
```

---

## Implementation phases

**Phase 0 — Rename (done)**
- `tools/vad-lab/` → `tools/lab/`, Cargo package `vad-lab` → `lab`
- All references updated: Cargo.toml, Makefile, release-please-config.json, README.md
- Build verified clean

**Phase 1 — Verify VAD still works end-to-end**
- Run `make dev-backend` + `make dev-frontend`, confirm VAD UI works as before
- Fix any issues from the rename before adding new features

**Phase 2 — Model download infrastructure**
- Add `models.toml` manifest to backend
- Implement cache-aware model loader
- Add `/models/status` and `/models/download` endpoints
- Add model status widget to frontend

**Phase 3 — Audio turn detection (Pipecat)**
- Add `/turn/audio/*` WebSocket endpoints
- Add `AudioTurnPanel` to frontend
- Wire up `AudioTurnDetector` (Pipecat, ~8 MB — likely already cached or quick to download)
- Show state + confidence on waveform timeline

**Phase 4 — Text turn detection (LiveKit)**
- Add `/turn/text/predict` REST endpoint
- Add `TextTurnPanel` with transcript + context editor
- Wire up `TextTurnDetector` (LiveKit, ~400 MB — triggers model download flow)

**Phase 5 — Pipeline mode (deferred)**
- Combined view: VAD speech events feed into turn detector automatically
- Timeline shows speech start/stop and EOU decisions together

---

## Open questions / blockers

1. **wavekat-turn backends functional?** The API traits are defined but it's unclear whether the
   Pipecat and LiveKit ONNX inference backends are fully implemented in v0.0.1. Verify this before
   starting Phase 3. Suggested: write a minimal integration test in wavekat-turn to confirm
   end-to-end inference works for both backends.

2. **wavekat-turn build script vs lab cache.** Confirm the `WAVEKAT_MODELS_DIR` (or equivalent)
   env var exists or can be added to wavekat-turn's build script so the lab can redirect model
   paths to the shared cache.

3. **Model URL sources.** The plan assumes the lab manifest references official model URLs
   (Hugging Face or similar). Confirm the URLs and licenses before implementing the download flow.
