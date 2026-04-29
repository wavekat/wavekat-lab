<p align="center">
  <a href="https://github.com/wavekat/wavekat-lab">
    <img src="https://github.com/wavekat/wavekat-brand/raw/main/assets/banners/wavekat-lab-narrow.svg" alt="WaveKat Lab">
  </a>
</p>

[![CI](https://github.com/wavekat/wavekat-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/wavekat/wavekat-lab/actions/workflows/ci.yml)
[![Release Please](https://github.com/wavekat/wavekat-lab/actions/workflows/release-please.yml/badge.svg)](https://github.com/wavekat/wavekat-lab/actions/workflows/release-please.yml)
[![DeepWiki](https://img.shields.io/badge/DeepWiki-wavekat%2Fwavekat--lab-blue.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAyCAYAAAAnWDnqAAAAAXNSR0IArs4c6QAAA05JREFUaEPtmUtyEzEQhtWTQyQLHNak2AB7ZnyXZMEjXMGeK/AIi+QuHrMnbChYY7MIh8g01fJoopFb0uhhEqqcbWTp06/uv1Utc/q9QCLuQAA9qVDnAU/UMM85L9xdz4SUL40e1jY4C9TF9mZAlpSEvAwk0VjDplPV9Frz2QILOWZKrk9aDAvHwYdb1OanbS3GG93sgYda8L3LjarS44V97ttH7sb6MQ93+0zdXamE6T/wgxTVw+OqzC72QoP3/eSj7t9Z6/u9zZ69m9R0vXoRPj/27POtCAvhT4Q+rhTPpBR0eDwa6+gqSAOBNQ2cnLHLA8CTTooP4FsXjB/0gMSCYtCdjlA86yZdTesOnXFGPDQrxPnHlkdoAvcAKt6QcRRRcVMuaSmDDR60Qh3RCtq+SwxlRBC6FlYxywkB87DDYtBIB2UFBR3KqZBrvBEsIotUGABQU2T0J5WtuYbJ8WPYI/hINb3a/zoBqMZqIXBT6GHRzfh0BTEegYGCBfMsZ2gjBhd7EYQYJoQRoLiCjRKLGJYsZUSF2nGLEFAjBEhNnnAj+t7iY67vkfLRfyfFhPlKDHvOPb09nRchALYUFK0RNNpwGZB/Cqc5n7DCB2yKTTMKNkPjUGbuI4nlmt1aKGZ8KaJZWyFnq5HIQyHbAdDESlF5NbCv4kzD6Bv8bqu+dsAkeyzAyDSITkmd1kAiSdCxx1QClrEjlLaXfPcJrPC+QDdLejQH7nTNMu9TzRoRtaaUEYwdFcc8nCOWaCpQ9aQDz1qaPZQ+dN7GGudSnrPcgZcfEv5MMHTOehB1RHAR3DEWsSQTBg2YvtinoZv4LWRYFCT89DKn9oQq8sYnWl5g0SC9j1MUMbBIRFCFCjGXxrh2KqnwM7t9CPhDS0KShKJI24+yNxvTDnE96b/hPV8AKf++78ehs4UWjfFaP/wEZbfJ5p2gQAAAAABJRU5ErkJggg==)](https://deepwiki.com/wavekat/wavekat-lab)

A research repo for the [WaveKat](https://github.com/wavekat) project — interactive tools and Jupyter notebooks for working with audio models (VAD, turn detection, voice datasets, and more).

> [!WARNING]
> Early development. Things may change.

## What's In Here

```
wavekat-lab/
├── tools/
│   ├── audio-lab/     Real-time VAD + Turn Detection comparison app (Rust + React)
│   └── cv-explorer/   Mozilla Common Voice dataset browser (Cloudflare Workers + React)
├── notebooks/         Jupyter notebooks (training, validation, dataset splits)
└── docs/              Plans and design docs
```

Each tool is self-contained — its own Makefile, lockfiles, and build setup live inside its folder.

## Tools

### [Audio Lab](tools/audio-lab/) — `tools/audio-lab/`

Web app for testing and comparing WaveKat library backends side by side in real time. Live mic capture, WAV upload, multi-config fan-out, VAD-gated pipeline mode, waveform + spectrogram + probability timelines.

Backends: webrtc-vad, silero-vad, ten-vad, firered-vad, pipecat smart-turn. [Details →](tools/audio-lab/README.md)

### [Common Voice Explorer](tools/cv-explorer/) — `tools/cv-explorer/`

Web app for browsing and playing audio clips from the [Mozilla Common Voice](https://commonvoice.mozilla.org) dataset. Filter by locale, split, demographics, and search sentences — with waveform playback powered by WaveSurfer.js. Built on Cloudflare Workers + D1 + R2. [Details →](tools/cv-explorer/README.md)

Live: <https://commonvoice-explorer.wavekat.com/>

## Notebooks

`notebooks/` is the home for Jupyter notebooks covering training, validation, and dataset-splitting workflows. Python env is managed by [uv](https://docs.astral.sh/uv/).

```bash
make setup-notebooks   # one-time: uv sync the notebook env
make lab               # start Jupyter Lab on notebooks/
```

## Repo Layout Conventions

- **Per-tool Makefiles** — `tools/<name>/Makefile` owns dev/build/CI for that tool. Run `cd tools/<name> && make help` to see what's there.
- **Root Makefile** — repo-wide only: `setup`, `lab`, `ci`, and per-tool CI delegators.
- **No shared Cargo workspace at root** — each Rust tool keeps its own `Cargo.toml` / `Cargo.lock` / `target/` inside its folder.

## Videos

| Video | Description |
|---|---|
| <a href="https://www.youtube.com/watch?v=8IScEH0ZJxA"><img src="https://img.youtube.com/vi/8IScEH0ZJxA/maxresdefault.jpg" alt="Common Voice Explorer Demo" width="400"></a> | **[Exploring Mozilla Common Voice with Common Voice Explorer](https://www.youtube.com/watch?v=8IScEH0ZJxA)** <br> Introducing Common Voice Explorer — browse and listen to 1.8M+ real voice clips from the Mozilla Common Voice dataset. |
| <a href="https://www.youtube.com/watch?v=_dRgH6FZRpM"><img src="https://img.youtube.com/vi/_dRgH6FZRpM/maxresdefault.jpg" alt="Pipecat Smart Turn Visual Test" width="400"></a> | **[Testing Pipecat Smart Turn with WaveKat Lab](https://www.youtube.com/watch?v=_dRgH6FZRpM)** <br> Visual test of Pipecat Smart Turn v3 — live recording and VAD-gated pipeline mode simulating production workflows. |
| <a href="https://www.youtube.com/watch?v=j2KkhpFRKaY"><img src="https://img.youtube.com/vi/j2KkhpFRKaY/maxresdefault.jpg" alt="FireRed VAD Showdown" width="400"></a> | **[Adding FireRedVAD as the 4th backend](https://www.youtube.com/watch?v=j2KkhpFRKaY)** <br> Benchmarking Xiaohongshu's FireRedVAD against Silero, TEN VAD, and WebRTC across accuracy and latency. |
| <a href="https://www.youtube.com/watch?v=450O3w9c-e8"><img src="https://img.youtube.com/vi/450O3w9c-e8/maxresdefault.jpg" alt="VAD Lab Demo" width="400"></a> | **[VAD Lab: Real-time multi-backend comparison](https://www.youtube.com/watch?v=450O3w9c-e8)** <br> Live demo of VAD Lab comparing WebRTC, Silero, and TEN VAD side by side with real-time waveform visualization. |

## License

Licensed under [Apache 2.0](LICENSE).

Copyright 2026 WaveKat.
