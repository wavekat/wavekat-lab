# Audio Lab

A web-based experimentation tool for testing and comparing [WaveKat](https://github.com/wavekat) library backends — VAD, turn detection, and more — side by side in real time.

> [!WARNING]
> Early development. Things may change.

## What It Does

- **Live recording** — capture audio from your microphone server-side, stream results to the browser in real time
- **File analysis** — upload a WAV file and run multiple configs against it at full speed
- **Side-by-side comparison** — fan out audio to N configurations simultaneously and compare outputs
- **Preprocessing exploration** — apply high-pass filters, RNNoise denoising, or normalization per-config
- **Interactive visualization** — waveform, spectrogram, and probability timelines with synchronized zoom, pan, and hover

## Quick Start

From the repo root:

```bash
make setup                          # one-time: install deps for all tools

cd tools/audio-lab
make dev-frontend                   # Terminal 1: frontend (http://localhost:5173)
make dev-backend                    # Terminal 2: backend with auto-rebuild (http://localhost:3000)
```

Or run the per-tool Makefile from the repo root with `-C`:

```bash
make -C tools/audio-lab dev-backend
```

### CLI Options

```
--host <HOST>    Bind address (default: 127.0.0.1)
--port <PORT>    Listen port (default: 3000)
```

## Supported Backends

### VAD

| Backend | Description | Key Parameters |
|---------|-------------|----------------|
| **webrtc-vad** | Google's WebRTC VAD — fast, low latency | Mode: quality, low-bitrate, aggressive, very-aggressive |
| **silero-vad** | Neural network VAD via ONNX Runtime — higher accuracy | Threshold: 0.0–1.0 |
| **ten-vad** | TEN framework VAD | Threshold: 0.0–1.0 |
| **firered-vad** | Xiaohongshu's FireRedVAD using DFSMN architecture | Threshold: 0.0–1.0 |

Each config can also enable per-config preprocessing: high-pass filter, RNNoise denoising, normalization.

### Turn Detection

| Backend | Description | Input |
|---------|-------------|-------|
| **pipecat** | Pipecat Smart Turn v3 — audio-based EOU detection | 16 kHz PCM audio |
| **livekit** | LiveKit Turn Detector — transcript-based EOU detection | ASR transcript text |

## Architecture

The Rust backend handles all audio capture and processing; the React frontend is embedded in the binary and handles visualization only.

```
┌─────────────────────────────────┐
│  Browser (React)                │
│  Waveform + Spectrogram +       │
│  Timelines + Config Panel       │
└──────────┬──────────────────────┘
           │ WebSocket
┌──────────▼──────────────────────┐
│  Server (Rust / Axum)           │
│  ┌────────────┐  ┌────────────┐ │
│  │ Mic Capture │  │ WAV Loader │ │
│  │   (cpal)    │  │  (hound)   │ │
│  └─────┬──────┘  └─────┬──────┘ │
│        └──────┬─────────┘        │
│        ┌──────▼──────┐           │
│        │ Audio Frames │          │
│        └──────┬──────┘           │
│     ┌─────────┼─────────┐       │
│     ▼         ▼         ▼       │
│  Config 1  Config 2  Config N   │
│     │         │         │       │
│     └─────────┼─────────┘       │
│          ┌────▼────┐             │
│          │ Results  │            │
│          └────┬────┘             │
└───────────────┼──────────────────┘
                ▼
           Browser UI
```

## Videos

| Video | Description |
|---|---|
| <a href="https://www.youtube.com/watch?v=_dRgH6FZRpM"><img src="https://img.youtube.com/vi/_dRgH6FZRpM/maxresdefault.jpg" alt="Pipecat Smart Turn Visual Test" width="400"></a> | **[Testing Pipecat Smart Turn with WaveKat Lab](https://www.youtube.com/watch?v=_dRgH6FZRpM)** <br> Visual test of Pipecat Smart Turn v3 — live recording and VAD-gated pipeline mode simulating production workflows. |
| <a href="https://www.youtube.com/watch?v=j2KkhpFRKaY"><img src="https://img.youtube.com/vi/j2KkhpFRKaY/maxresdefault.jpg" alt="FireRed VAD Showdown" width="400"></a> | **[Adding FireRedVAD as the 4th backend](https://www.youtube.com/watch?v=j2KkhpFRKaY)** <br> Benchmarking Xiaohongshu's FireRedVAD against Silero, TEN VAD, and WebRTC across accuracy and latency. |
| <a href="https://www.youtube.com/watch?v=450O3w9c-e8"><img src="https://img.youtube.com/vi/450O3w9c-e8/maxresdefault.jpg" alt="VAD Lab Demo" width="400"></a> | **[VAD Lab: Real-time multi-backend comparison](https://www.youtube.com/watch?v=450O3w9c-e8)** <br> Live demo of VAD Lab comparing WebRTC, Silero, and TEN VAD side by side with real-time waveform visualization. |
