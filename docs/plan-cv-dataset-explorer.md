# Plan: Common Voice Dataset Explorer

**Status:** Planning
**Date:** 2026-04-03

---

## Goal

Build a lightweight tool to **browse and listen** to Common Voice audio clips, filtered by
text content, sentence length, or keywords. The purpose is to develop intuition about the
dataset before training a turn detection model — hear what the data sounds like, spot
patterns, and identify useful subsets.

---

## Data Strategy

### Download → Ingest → Own the data

The Mozilla Data Collective API only supports full-dataset downloads — no per-clip querying
or filtering. Rather than working around this limitation with HuggingFace proxying (which
also lacks server-side filtering), we **download the dataset once and ingest it into our own
Cloudflare infrastructure**:

1. **Download** the Common Voice dataset via the Data Collective API (presigned URL)
2. **Extract** the TSV metadata + MP3 audio files
3. **Ingest** metadata into **Cloudflare D1** (SQLite) — sentences, demographics, paths
4. **Upload** audio files to **Cloudflare R2** (S3-compatible object storage)

This gives us full control: real SQL queries for filtering, fast audio serving from R2,
no external API rate limits at runtime.

### Dataset size considerations

Common Voice English (v17.0) is ~100 GB uncompressed. Options:
- **Start with a smaller locale** (e.g., `zh-TW` or `ja`) to validate the pipeline
- **Ingest a subset** — e.g., only the `validated` split, or first N clips
- **Ingest incrementally** — the sync script can resume/append

---

## Architecture

```
┌─────────────────────┐       ┌─────────────────────────────┐
│   Cloudflare Pages  │       │   Cloudflare Worker (Hono)  │
│   (React SPA)       │──────▶│   /api/clips        → D1   │
│                     │       │   /api/clips/:id    → D1   │
│   - Filter panel    │       │   /api/audio/:path  → R2   │
│   - Clip list       │       │                             │
│   - Audio player    │       └──────┬──────────┬───────────┘
└─────────────────────┘              │          │
                              ┌──────▼───┐ ┌───▼────────┐
                              │   D1     │ │   R2       │
                              │ (SQLite) │ │ (audio)    │
                              │          │ │            │
                              │ clips    │ │ en/clips/  │
                              │ metadata │ │  *.mp3     │
                              └──────────┘ └────────────┘

        ┌───────────────────────────────────────────────┐
        │   GitHub Actions (self-hosted runner)          │
        │   workflow_dispatch: locale, split, version    │
        │                                               │
        │   1. Download from Data Collective            │
        │   2. Parse TSV metadata                       │
        │   3. INSERT into D1 ──────────────────────────┼──▶ D1
        │   4. Upload MP3s to R2 ───────────────────────┼──▶ R2
        └───────────────────────────────────────────────┘
```

### Why a separate `tools/` directory?

This tool is **not part of the main wavekat-lab app** (Rust backend + React frontend). It is:
- A standalone utility for dataset exploration
- Deployed independently via Cloudflare (not the main app's infra)
- Has its own dependencies (Cloudflare Workers SDK, not Rust)

Keeping it in `tools/cv-explorer/` makes the boundary clear.

---

## Project Structure

```
tools/
  cv-explorer/
    worker/                      # Cloudflare Worker (API + R2 serving)
      src/
        index.ts                 # Hono app entry point
        routes/
          clips.ts               # GET /api/clips — query D1 with filters
          audio.ts               # GET /api/audio/:path — serve from R2
      migrations/
        0001_create_clips.sql    # D1 schema
      wrangler.toml              # Worker config (D1, R2 bindings)
      package.json
      tsconfig.json

    web/                         # React SPA (Cloudflare Pages)
      src/
        App.tsx
        components/
          FilterPanel.tsx        # Text search, length range, locale selector
          ClipList.tsx           # Paginated list of matching clips
          AudioPlayer.tsx        # Inline audio player
        lib/
          api.ts                 # Fetch wrapper for the worker API
      index.html
      package.json
      vite.config.ts
      tsconfig.json

    scripts/                     # Data pipeline (runs on self-hosted GH Actions runner)
      sync.ts                    # Download CV dataset → parse → ingest D1 + R2
      package.json
      tsconfig.json

.github/
  workflows/
    cv-runner-provision.yml      # workflow_dispatch → create Azure VM + register runner
    cv-sync.yml                  # workflow_dispatch → run sync on Azure VM runner
```

---

## D1 Schema

```sql
CREATE TABLE clips (
  id         TEXT PRIMARY KEY,      -- e.g. "common_voice_en_39876"
  locale     TEXT NOT NULL,
  split      TEXT NOT NULL,         -- "train", "dev", "test", "validated", etc.
  path       TEXT NOT NULL,         -- R2 key: "en/clips/common_voice_en_39876.mp3"
  sentence   TEXT NOT NULL,
  word_count INTEGER NOT NULL,      -- pre-computed for fast filtering
  char_count INTEGER NOT NULL,      -- pre-computed for fast filtering
  up_votes   INTEGER DEFAULT 0,
  down_votes INTEGER DEFAULT 0,
  age        TEXT,
  gender     TEXT,
  accent     TEXT
);

CREATE INDEX idx_clips_locale_split ON clips(locale, split);
CREATE INDEX idx_clips_word_count   ON clips(word_count);
CREATE INDEX idx_clips_char_count   ON clips(char_count);
CREATE INDEX idx_clips_sentence     ON clips(sentence);  -- for LIKE queries
```

D1 supports SQLite FTS5 if we need full-text search later, but `LIKE '%keyword%'` is
sufficient for MVP given the indexed dataset sizes we'll start with.

---

## Features (MVP)

### Filtering
- **Text search** — `LIKE '%query%'` on sentence text (case-insensitive)
- **Word count range** — min/max word count slider
- **Locale** — language selector (based on what's been ingested)
- **Split** — dataset split selector (train/dev/test/validated)

### Clip List
- Paginated table showing: sentence text, word count, gender, age, votes
- Sort by word count, votes, etc.
- Click a row to select it

### Audio Playback
- Inline `<audio>` player for the selected clip
- **Waveform visualization** — render waveform for the selected clip (e.g. wavesurfer.js)
- Play/pause, scrub, playback speed control
- Keyboard shortcut: spacebar to play/pause, arrow keys to navigate clips

### Analytics
- **Google Analytics (GA4)** — integrated via gtag.js
- Track page views, filter usage, clip playback events

### Nice-to-have (post-MVP)
- Batch download/export selected clips
- Bookmark/tag clips for later use
- FTS5 full-text search

---

## Tech Stack

| Layer    | Tech                        | Why                                        |
|----------|-----------------------------|--------------------------------------------|
| API      | Cloudflare Workers + Hono   | Lightweight, edge-deployed, good DX        |
| Database | Cloudflare D1 (SQLite)      | SQL filtering, FTS5 support, free tier     |
| Storage  | Cloudflare R2               | S3-compatible, no egress fees, fast        |
| Frontend | React + Vite + Tailwind     | Consistent with main app's frontend stack  |
| Sync     | GH Actions (self-hosted)    | No disk/time limits, `workflow_dispatch`   |
| Deploy   | Cloudflare Pages + Workers  | Single platform, simple CI/CD              |

---

## API Design

### `GET /api/clips`

Query params:
- `locale` (string, default `en`) — Common Voice locale code
- `split` (string, default `train`) — Dataset split
- `q` (string, optional) — Text search query (LIKE match)
- `min_words` (number, optional) — Minimum word count
- `max_words` (number, optional) — Maximum word count
- `min_chars` (number, optional) — Minimum character count
- `max_chars` (number, optional) — Maximum character count
- `gender` (string, optional) — Filter by gender
- `age` (string, optional) — Filter by age group
- `sort` (string, default `id`) — Sort field
- `order` (string, default `asc`) — Sort order
- `offset` (number, default 0) — Pagination offset
- `limit` (number, default 50, max 100) — Page size

Response:
```json
{
  "clips": [
    {
      "id": "common_voice_en_123456",
      "sentence": "Hello, how are you?",
      "audio_url": "/api/audio/en/clips/common_voice_en_123456.mp3",
      "word_count": 4,
      "char_count": 19,
      "gender": "female",
      "age": "twenties",
      "accent": "",
      "up_votes": 3,
      "down_votes": 0
    }
  ],
  "total": 1234,
  "offset": 0,
  "limit": 50
}
```

### `GET /api/audio/:path+`

Serves audio file from R2. Returns `audio/mpeg` with cache headers.

### `GET /api/stats`

Returns ingested dataset stats: total clips per locale/split, for the locale selector UI.

---

## Data Sync — Ephemeral Azure VM as GitHub Actions Runner

The sync runs on an **ephemeral Azure VM** that is provisioned on-demand as a self-hosted
GitHub Actions runner. The VM is created when the workflow is triggered, does the work,
and **auto-shuts down** after a configurable timeout. Zero idle cost.

### Why ephemeral Azure VM?

| Concern                | GitHub-hosted runner     | Ephemeral Azure VM        |
|------------------------|--------------------------|---------------------------|
| Disk space             | ~14 GB free              | As much as we provision   |
| Job timeout            | 6 hours max              | Configurable (default 2h) |
| Large datasets (100GB) | Won't fit                | Works fine                |
| Idle cost              | N/A                      | $0 — VM is deleted after  |
| Setup                  | None                     | Automated via workflow    |

### How it works — two workflows

#### 1. `.github/workflows/cv-runner-provision.yml` — Provision the VM

Triggered manually. Spins up an Azure VM, installs dependencies, registers as a
GitHub Actions runner, and sets an auto-shutdown timer.

```yaml
name: "CV: Provision Runner"

on:
  workflow_dispatch:
    inputs:
      vm_size:
        description: "Azure VM size"
        required: true
        default: "Standard_D4s_v3"    # 4 vCPU, 16 GB RAM
        type: choice
        options:
          - Standard_D2s_v3           # 2 vCPU, 8 GB RAM
          - Standard_D4s_v3           # 4 vCPU, 16 GB RAM
          - Standard_D8s_v3           # 8 vCPU, 32 GB RAM
      disk_size_gb:
        description: "OS disk size in GB"
        required: true
        default: "256"
      max_hours:
        description: "Auto-shutdown after N hours"
        required: true
        default: "2"

jobs:
  provision:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Azure Login
        uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}

      - name: Create VM
        uses: azure/cli@v2
        with:
          inlineScript: |
            RUNNER_NAME="cv-sync-$(date +%s)"
            RESOURCE_GROUP="${{ secrets.AZURE_RESOURCE_GROUP }}"

            # Create VM with specified disk size
            az vm create \
              --resource-group "$RESOURCE_GROUP" \
              --name "$RUNNER_NAME" \
              --image Ubuntu2404 \
              --size "${{ inputs.vm_size }}" \
              --os-disk-size-gb "${{ inputs.disk_size_gb }}" \
              --admin-username azureuser \
              --generate-ssh-keys \
              --public-ip-sku Standard

            # Schedule auto-shutdown
            SHUTDOWN_TIME=$(date -u -d "+${{ inputs.max_hours }} hours" +%H%M)
            az vm auto-shutdown \
              --resource-group "$RESOURCE_GROUP" \
              --name "$RUNNER_NAME" \
              --time "$SHUTDOWN_TIME"

            # Run cloud-init: install deps + register GH Actions runner
            az vm run-command invoke \
              --resource-group "$RESOURCE_GROUP" \
              --name "$RUNNER_NAME" \
              --command-id RunShellScript \
              --scripts '
                set -e

                # Install Node.js 22
                curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
                apt-get install -y nodejs

                # Create runner user
                useradd -m runner
                cd /home/runner

                # Download and configure GitHub Actions runner
                RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed "s/v//")
                curl -o actions-runner.tar.gz -L "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
                tar xzf actions-runner.tar.gz
                rm actions-runner.tar.gz
                chown -R runner:runner /home/runner

                # Register as ephemeral runner (auto-deregisters after one job)
                su - runner -c "./config.sh \
                  --url https://github.com/${{ github.repository }} \
                  --token ${{ secrets.GH_RUNNER_REG_TOKEN }} \
                  --name '"$RUNNER_NAME"' \
                  --labels cv-sync \
                  --ephemeral \
                  --unattended"

                # Install and start as service
                ./svc.sh install runner
                ./svc.sh start

                # Schedule VM self-destruct after max_hours
                echo "az vm delete --resource-group '"$RESOURCE_GROUP"' --name '"$RUNNER_NAME"' --yes --force-deletion" | \
                  at now + ${{ inputs.max_hours }} hours
              '

      - name: Summary
        run: |
          echo "## Runner Provisioned" >> "$GITHUB_STEP_SUMMARY"
          echo "- **VM:** cv-sync-*" >> "$GITHUB_STEP_SUMMARY"
          echo "- **Size:** ${{ inputs.vm_size }}" >> "$GITHUB_STEP_SUMMARY"
          echo "- **Disk:** ${{ inputs.disk_size_gb }} GB" >> "$GITHUB_STEP_SUMMARY"
          echo "- **Auto-shutdown:** ${{ inputs.max_hours }} hours" >> "$GITHUB_STEP_SUMMARY"
          echo "- **Runner label:** \`cv-sync\`" >> "$GITHUB_STEP_SUMMARY"
          echo "" >> "$GITHUB_STEP_SUMMARY"
          echo "Now trigger the **CV Dataset Sync** workflow." >> "$GITHUB_STEP_SUMMARY"
```

#### 2. `.github/workflows/cv-sync.yml` — Run the sync

Triggered after the runner is online. Runs on the `cv-sync` label (the Azure VM).

```yaml
name: "CV: Dataset Sync"

on:
  workflow_dispatch:
    inputs:
      locale:
        description: "Common Voice locale (e.g. en, ja, zh-TW)"
        required: true
        default: "en"
      split:
        description: "Dataset split (validated, train, dev, test)"
        required: true
        default: "validated"
      version:
        description: "Common Voice version (e.g. cv-corpus-17.0-2024-03-15)"
        required: true
        default: "cv-corpus-17.0-2024-03-15"

jobs:
  sync:
    runs-on: cv-sync                  # matches the label from provisioning
    steps:
      - uses: actions/checkout@v6
      - run: npm ci
        working-directory: tools/cv-explorer/scripts
      - name: Sync dataset
        run: |
          npx tsx sync.ts \
            --locale ${{ inputs.locale }} \
            --split ${{ inputs.split }} \
            --version ${{ inputs.version }}
        working-directory: tools/cv-explorer/scripts
        env:
          DATACOLLECTIVE_API_KEY: ${{ secrets.DATACOLLECTIVE_API_KEY }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          D1_DATABASE_ID: ${{ secrets.CV_EXPLORER_D1_ID }}
          R2_BUCKET_NAME: ${{ secrets.CV_EXPLORER_R2_BUCKET }}
```

### Workflow: typical usage

```
1. Trigger "CV: Provision Runner" (pick VM size, disk, max hours)
2. Wait ~2 min for VM to come online
3. Trigger "CV: Dataset Sync" (pick locale, split, version)
4. Sync runs on the Azure VM
5. VM auto-shuts down after max_hours (or after the ephemeral job completes)
```

### Sync script: `tools/cv-explorer/scripts/sync.ts`

The script does the actual work:

```
Steps:
1. Call Data Collective API → get presigned download URL
2. Download + extract tar.gz (streamed, not fully buffered)
3. Parse TSV metadata (validated.tsv, train.tsv, etc.)
4. Batch INSERT rows into D1 (via Cloudflare REST API, 1000 rows/batch)
5. Upload MP3s to R2 (via S3-compatible API, parallelized, skip existing)
6. Report: X clips ingested, Y audio files uploaded, Z skipped
```

Features:
- **Resumable** — skips already-uploaded R2 objects, uses `INSERT OR IGNORE` for D1
- **Progress reporting** — logs progress to GitHub Actions step summary
- **Parallelized uploads** — configurable concurrency for R2 uploads (default: 20)

### Required secrets

| Secret                     | Description                                      |
|----------------------------|--------------------------------------------------|
| `AZURE_CREDENTIALS`        | Azure service principal JSON (for `azure/login`) |
| `AZURE_RESOURCE_GROUP`     | Azure resource group for VMs                     |
| `GH_RUNNER_REG_TOKEN`      | GitHub runner registration token                 |
| `DATACOLLECTIVE_API_KEY`   | Mozilla Data Collective API key                  |
| `CLOUDFLARE_ACCOUNT_ID`    | Cloudflare account ID                            |
| `CLOUDFLARE_API_TOKEN`     | Cloudflare API token (D1 + R2 permissions)       |
| `CV_EXPLORER_D1_ID`        | D1 database ID                                   |
| `CV_EXPLORER_R2_BUCKET`    | R2 bucket name                                   |

---

## Open Questions

1. **Which locale to start with?** English is huge (~100 GB). A smaller locale like `zh-TW`
   or `ja` would be faster to validate the pipeline, but English is more relevant for turn
   detection training.
2. **Dataset version** — Pin to Common Voice v17.0 or support multiple versions?
3. **D1 row limits** — D1 free tier allows 5 GB storage. English validated split has ~1.6M
   clips — metadata should fit. Need to verify.
4. **R2 storage costs** — R2 free tier: 10 GB storage, 10M reads/month. A subset of audio
   may fit; full English will exceed this. Check pricing for our expected usage.

---

## Implementation Phases

### Phase 1: Infra + sync pipeline
- Set up `tools/cv-explorer/` structure
- Create D1 database + R2 bucket via Wrangler
- Build sync script (`scripts/sync.ts`)
- Create Azure resource group + service principal
- Create `cv-runner-provision.yml` (ephemeral Azure VM runner)
- Create `cv-sync.yml` (dataset sync workflow)
- Test with a small locale (e.g., `ja` or `zh-TW`)

### Phase 2: Worker API
- Implement Hono worker: clips query (D1) + audio serving (R2)
- D1 migration for schema
- Deploy Worker, verify filtering works

### Phase 3: Web UI
- React app with filter panel, clip list, audio player
- Deploy to Cloudflare Pages
- Wire up to Worker API

### Phase 4: Polish + scale
- FTS5 full-text search
- Waveform visualization
- Ingest English + more locales
- Keyboard navigation
- Bookmark/export clips
