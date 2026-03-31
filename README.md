<p align="center">
  <a href="https://github.com/wavekat/wavekat-lab">
    <img src="https://github.com/wavekat/wavekat-brand/raw/main/assets/banners/wavekat-lab-narrow.svg" alt="WaveKat Lab">
  </a>
</p>

[![CI](https://github.com/wavekat/wavekat-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/wavekat/wavekat-lab/actions/workflows/ci.yml)
[![Release Please](https://github.com/wavekat/wavekat-lab/actions/workflows/release-please.yml/badge.svg)](https://github.com/wavekat/wavekat-lab/actions/workflows/release-please.yml)
[![DeepWiki](https://img.shields.io/badge/DeepWiki-wavekat%2Fwavekat--vad-blue.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAyCAYAAAAnWDnqAAAAAXNSR0IArs4c6QAAA05JREFUaEPtmUtyEzEQhtWTQyQLHNak2AB7ZnyXZMEjXMGeK/AIi+QuHrMnbChYY7MIh8g01fJoopFb0uhhEqqcbWTp06/uv1saEDv4O3n3dV60RfP947Mm9/SQc0ICFQgzfc4CYZoTPAswgSJCCUJUnAAoRHOAUOcATwbmVLWdGoH//PB8mnKqScAhsD0kYP3j/Yt5LPQe2KvcXmGvRHcDnpxfL2zOYJ1mFwrryWTz0advv1Ut4CJgf5uhDuDj5eUcAUoahrdY/56ebRWeraTjMt/00Sh3UDtjgHtQNHwcRGOC98BJEAEymycmYcWwOprTgcB6VZ5JK5TAJ+fXGLBm3FDAmn6oPPjR4rKCAoJCal2eAiQp2x0vxTPB3ALO2CRkwmDy5WohzBDwSEFKRwPbknEggCPB/imwrycgxX2NzoMCHhPkDwqYMr9tRcP5qNrMZHkVnOjRMWwLCcr8ohBVb1OMjxLwGCvjTikrsBOiA6fNyCrm8V1rP93iVPpwaE+gO0SsWmPiXB+jikdf6SizrT5qKasx5j8ABbHpFTx+vFXp9EnYQmLx02h1QTTrl6eDqxLnGjporxl3NL3agEvXdT0WmEost648sQOYAeJS9Q7bfUVoMGnjo4AZdUMQku50McDcMWcBPvr0SzbTAFDfvJqwLzgxwATnCgnp4wDl6Aa+Ax283gghmj+vj7feE2KBBRMW3FzOpLOADl0Isb5587h/U4gGvkt5v60Z1VLG8BhYjbzRwyQZemwAd6cCR5/XFWLYZRIMpX39AR0tjaGGiGzLVyhse5C9RKC6ai42ppWPKiBagOvaYk8lO7DajerabOZP46Lby5wKjw1HCRx7p9sVMOWGzb/vA1hwiWc6jm3MvQDTogQkiqIhJV0nBQBTU+3okKCFDy9WwferkHjtxib7t3xIUQtHxnIwtx4mpg26/HfwVNVDb4oI9RHmx5WGelRVlrtiw43zboCLaxv46AZeB3IlTkwouebTr1y2NjSpHz68WNFjHvupy3q8TFn3Hos2IAk4Ju5dCo8B3wP7VPr/FGaKiG+T+v+TQqIrOqMTL1VdWV1DdmcbO8KXBz6esmYWYKPwDL5b5FA1a0hwapHiom0r/cKaoqr+27/XcrS5UwSMbQAAAABJRU5ErkJggg==)](https://deepwiki.com/wavekat/wavekat-vad)

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

```bash
make setup         # one-time: install dependencies

make dev-frontend  # Terminal 1: frontend (http://localhost:5173)
make dev-backend   # Terminal 2: backend with auto-rebuild (http://localhost:3000)
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

## License

Licensed under [Apache 2.0](LICENSE).

Copyright 2026 WaveKat.
