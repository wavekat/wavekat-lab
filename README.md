<p align="center">
  <a href="https://github.com/wavekat/wavekat-lab">
    <img src="https://github.com/wavekat/wavekat-brand/raw/main/assets/banners/wavekat-lab-narrow.svg" alt="WaveKat Lab">
  </a>
</p>

Developer experimentation tools for the [WaveKat](https://github.com/wavekat) libraries.

> [!WARNING]
> Early development. Tools may change.

## Tools

| Tool | Description |
|------|-------------|
| [lab](tools/lab/) | Web-based tool for testing and comparing VAD and turn detection backends side by side |

## Quick Start

```bash
make setup         # one-time: install dependencies

make dev-frontend  # Terminal 1: frontend (http://localhost:5173)
make dev-backend   # Terminal 2: backend with auto-rebuild (http://localhost:3000)
```

See [tools/lab/README.md](tools/lab/README.md) for full usage and options.

## Overview

wavekat-lab is a collection of developer tools for understanding and experimenting with WaveKat libraries before choosing backends or tuning parameters. These are not shipped products — they are dev tools.

## License

Licensed under [Apache 2.0](LICENSE).

Copyright 2026 WaveKat.
