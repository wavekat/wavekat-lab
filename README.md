<p align="center">
  <img src="https://github.com/wavekat/wavekat-brand/raw/main/assets/banners/wavekat-lab-narrow.svg" alt="WaveKat Lab">
</p>

Developer experimentation tools for the [WaveKat](https://github.com/wavekat) libraries.

> [!WARNING]
> Early development. Tools may change.

## Tools

| Tool | Description |
|------|-------------|
| [vad-lab](tools/vad-lab/) | Web-based tool for testing and comparing VAD backends side by side |

## Quick Start

```bash
# Terminal 1: frontend dev server (http://localhost:5173)
cd tools/vad-lab/frontend && npm install && npm run dev

# Terminal 2: backend (http://localhost:3000)
cargo run -p vad-lab
```

See [tools/vad-lab/README.md](tools/vad-lab/README.md) for full usage and options.

## Overview

wavekat-lab is a collection of developer tools for understanding and experimenting with WaveKat libraries before choosing backends or tuning parameters. These are not shipped products — they are dev tools.

## License

Licensed under [Apache 2.0](LICENSE).

Copyright 2026 WaveKat.
