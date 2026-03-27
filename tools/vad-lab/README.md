# vad-lab

A web-based experimentation tool for testing and comparing Voice Activity Detection (VAD) backends in real time. Run multiple VAD configurations side by side on live microphone input or WAV files, and instantly see how they differ.

> **Note:** vad-lab is a developer tool for experimentation, not a shipped product. It helps you understand VAD behavior before choosing a backend or tuning parameters.

## What It Does

- **Live recording** — capture audio from your microphone server-side, stream VAD results to the browser in real time
- **File analysis** — upload a WAV file and run multiple VAD configs against it at full speed
- **Side-by-side comparison** — fan out audio to N VAD configurations simultaneously and compare their speech probability outputs
- **Preprocessing exploration** — apply high-pass filters, RNNoise denoising, or normalization per-config to see how preprocessing affects detection
- **Interactive visualization** — waveform display, spectrogram, and VAD probability timelines with synchronized zoom, pan, and hover

## Supported Backends

| Backend | Description | Key Parameters |
|---------|-------------|----------------|
| **webrtc-vad** | Google's WebRTC VAD — fast, low latency | Mode: quality, low-bitrate, aggressive, very-aggressive |
| **silero-vad** | Neural network VAD via ONNX Runtime — higher accuracy | Threshold: 0.0 - 1.0 |
| **ten-vad** | TEN framework VAD | Threshold: 0.0 - 1.0 |
| **firered-vad** | Xiaohongshu's FireRedVAD using DFSMN architecture | Threshold: 0.0 - 1.0 |

Each config can also enable per-config preprocessing:

- **High-pass filter** (20-500 Hz cutoff)
- **RNNoise denoising**
- **Normalization** to a target dBFS level (-40 to 0)

## Architecture

vad-lab is a single binary. The Rust backend handles all audio capture and processing; the React frontend is embedded in the binary and handles visualization only.

```
┌─────────────────────────────────┐
│  Browser (React)                │
│  Waveform + Spectrogram +       │
│  VAD Timelines + Config Panel   │
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
│  (webrtc)  (silero)   (...)     │
│     │         │         │       │
│     └─────────┼─────────┘       │
│          ┌────▼────┐             │
│          │ Results  │            │
│          └────┬────┘             │
│               │ stream           │
└───────────────┼──────────────────┘
                ▼
           Browser UI
```

## Getting Started

### Prerequisites

- Rust toolchain (stable)
- Node.js and npm (for frontend development)

### Development Mode

First-time setup (installs cargo-watch and npm dependencies):

```bash
make setup
```

Then run the frontend dev server and backend in separate terminals:

```bash
# Terminal 1: frontend (http://localhost:5173)
make dev-frontend

# Terminal 2: backend with auto-rebuild (http://localhost:3000)
make dev-backend
```

### CLI Options

```
--host <HOST>    Bind address (default: 127.0.0.1)
--port <PORT>    Listen port (default: 3000)
```

## Usage

1. Open the UI in your browser (default: `http://localhost:3000`)
2. Configure one or more VAD backends in the config panel — defaults are provided for all three backends
3. Either click **Record** to capture from your mic, or **Upload** a WAV file
4. Watch the waveform, spectrogram, and per-config VAD probability timelines update in real time
5. Use zoom/pan to inspect specific regions; hover to see exact probability values
6. Toggle **Show Preprocessed** on any config to compare raw vs. preprocessed audio

### Visualization Features

- **Waveform** — linear or log scale, vertical zoom (1x–32x), click-to-seek playback
- **Spectrogram** — linear, log, or mel frequency scaling with configurable bin resolution (32–512)
- **VAD Timeline** — per-config probability bars with real-time factor (RTF) badges showing inference speed
- **Audio Playback** — play back original or preprocessed audio in the browser
- **WAV Export** — download captured audio as a WAV file

## Performance Metrics

Each VAD timeline displays a **Real-Time Factor (RTF)** badge — the ratio of inference time to audio duration. An RTF < 1.0 means the backend processes audio faster than real time.

## WebSocket Protocol

The frontend and backend communicate over a single WebSocket connection. Key message types:

**Client to server:**

| Message | Description |
|---------|-------------|
| `list_devices` | Enumerate available microphones |
| `list_backends` | Get available VAD backends and their parameter schemas |
| `set_configs` | Send VAD configurations to the server |
| `start_recording` | Begin mic capture |
| `stop_recording` | End mic capture |
| `load_file` | Upload and process a WAV file |

**Server to client:**

| Message | Description |
|---------|-------------|
| `devices` | List of audio input devices |
| `backends` | Available backends with parameter definitions |
| `audio` | Raw audio frame (i16 samples) |
| `spectrum` | FFT magnitude spectrum in dB |
| `vad` | Speech probability result for a specific config |
| `preprocessed_audio` | Audio after per-config preprocessing |
| `preprocessed_spectrum` | Spectrum of preprocessed audio |
| `done` | Processing complete |
