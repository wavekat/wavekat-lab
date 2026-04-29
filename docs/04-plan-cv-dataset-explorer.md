# Plan: Common Voice Dataset Explorer

**Status:** Shipped in v0.0.10 (PR [#24](https://github.com/wavekat/wavekat-lab/pull/24)). Live at <https://commonvoice-explorer.wavekat.com/>.
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
                              │ datasets │ │ en/clips/  │
                              │ clips    │ │  *.mp3     │
                              └──────────┘ └────────────┘

        ┌───────────────────────────────────────────────┐
        │   GitHub Actions (self-hosted runner)          │
        │   workflow_dispatch: dataset-id, split         │
        │                                               │
        │   1. Check datasets table — skip if synced    │
        │   2. Download from Data Collective            │
        │   3. Auto-detect locale + version from archive│
        │   4. Parse TSV metadata (one or all splits)   │
        │   5. DELETE + INSERT into D1 ─────────────────┼──▶ D1
        │   6. Upload MP3s to R2 ───────────────────────┼──▶ R2
        │   7. Update datasets table → "synced"         │
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
        0001_create_datasets.sql # D1 schema: datasets registry
        0002_create_clips.sql    # D1 schema: clips metadata
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

Two tables: `datasets` (sync registry) and `clips` (per-clip metadata).

### `datasets` — sync registry

Tracks what has been synced. Powers the frontend dataset dropdown and prevents
unnecessary re-downloads.

```sql
CREATE TABLE datasets (
  id          TEXT PRIMARY KEY,      -- "{version}/{locale}/{split}"
  dataset_id  TEXT NOT NULL,         -- Data Collective ID (for re-download)
  version     TEXT NOT NULL,         -- e.g. "cv-corpus-25.0-2026-03-09"
  locale      TEXT NOT NULL,         -- auto-detected from archive
  split       TEXT NOT NULL,         -- "validated", "train", "dev", "test", etc.
  clip_count  INTEGER DEFAULT 0,
  size_bytes  INTEGER DEFAULT 0,     -- archive size from API
  status      TEXT NOT NULL,         -- "syncing", "synced", "failed"
  synced_at   TEXT                   -- ISO 8601 timestamp of last sync
);

CREATE INDEX idx_datasets_status ON datasets(status);
```

### `clips` — per-clip metadata

```sql
CREATE TABLE clips (
  id         TEXT PRIMARY KEY,      -- e.g. "common_voice_en_39876"
  version    TEXT NOT NULL,         -- e.g. "cv-corpus-25.0-2026-03-09"
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
CREATE INDEX idx_clips_version      ON clips(version, locale, split);
CREATE INDEX idx_clips_word_count   ON clips(word_count);
CREATE INDEX idx_clips_char_count   ON clips(char_count);
CREATE INDEX idx_clips_sentence     ON clips(sentence);  -- for LIKE queries
```

### Re-sync strategy

On re-sync of the same version/locale/split:
1. `DELETE FROM clips WHERE version = ? AND locale = ? AND split = ?` (bulk wipe)
2. Insert fresh rows
3. R2 uploads skip existing objects (same audio = same key = skip)

This avoids per-row `REPLACE` costs while ensuring metadata is up-to-date.

D1 supports SQLite FTS5 if we need full-text search later, but `LIKE '%keyword%'` is
sufficient for MVP given the indexed dataset sizes we'll start with.

---

## Features (MVP)

### Filtering
- **Dataset selector** — dropdown populated from `datasets` table (synced datasets only)
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

### `GET /api/datasets`

Returns all synced datasets, for populating the dataset dropdown.

```json
{
  "datasets": [
    {
      "id": "cv-corpus-25.0-2026-03-09/zh-TW/validated",
      "version": "cv-corpus-25.0-2026-03-09",
      "locale": "zh-TW",
      "split": "validated",
      "clip_count": 85324,
      "synced_at": "2026-04-03T12:00:00Z"
    }
  ]
}
```

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

Inputs:
- **`dataset_id`** (required) — Data Collective dataset ID (from the dataset page URL)
- **`split`** (required, default `all`) — Which split to sync. `all` syncs every TSV found.

Locale and version are **auto-detected** from the extracted archive directory name
(e.g., `cv-corpus-25.0-2026-03-09/zh-TW/`). No need to specify them manually.

```yaml
name: "CV: Dataset Sync"

on:
  workflow_dispatch:
    inputs:
      dataset_id:
        description: "Data Collective dataset ID"
        required: true
      split:
        description: "Dataset split (or 'all')"
        required: true
        default: "all"
        type: choice
        options:
          - all
          - validated
          - train
          - dev
          - test
          - invalidated
          - other
```

### Workflow: typical usage

```
1. Trigger "CV: Provision Runner" (pick VM size, disk, max hours)
2. Wait ~2 min for VM to come online
3. Trigger "CV: Dataset Sync" (pick dataset_id, split)
4. Script checks datasets table — skips if already synced
5. Downloads, extracts, auto-detects locale + version
6. Syncs selected split (or all splits) to D1 + R2
7. Updates datasets table with status + metadata
8. VM auto-shuts down after max_hours (or after the ephemeral job completes)
```

### Sync script: `tools/cv-explorer/scripts/sync.ts`

The script does the actual work:

```
Usage:
  npx tsx sync.ts --dataset-id <id> --split validated
  npx tsx sync.ts --dataset-id <id> --split all
  npx tsx sync.ts --dataset-id <id> --split all --force   # re-sync even if already synced

Steps:
1. Query datasets table — if status = "synced" for this dataset/split, skip (unless --force)
2. Upsert datasets row with status = "syncing"
3. Call Data Collective API → get presigned download URL
4. Download + extract tar.gz (streamed, not fully buffered)
5. Auto-detect version + locale from archive dir (e.g. cv-corpus-25.0-2026-03-09/zh-TW/)
6. If split = "all", find all *.tsv files; otherwise use the specified split
7. For each split:
   a. Parse TSV metadata
   b. DELETE FROM clips WHERE version/locale/split match (clean slate)
   c. Batch INSERT rows into D1 (via Cloudflare REST API, batched)
   d. Upload MP3s to R2 (S3-compatible API, parallelized, skip existing)
8. Update datasets row → status = "synced", clip_count, size_bytes, synced_at
9. On failure → update status = "failed"
```

Features:
- **Skip-if-synced** — checks datasets table before downloading; `--force` overrides
- **Auto-detect** — locale and version parsed from archive, not manual input
- **Split "all"** — syncs every TSV found in the locale directory
- **Clean re-sync** — DELETE + INSERT per version/locale/split (no stale rows)
- **R2 dedup** — skips already-uploaded audio objects (same key = skip)
- **Progress reporting** — logs progress to GitHub Actions step summary
- **Parallelized uploads** — configurable concurrency for R2 uploads (default: 20)

### Setup guide

See [`.github/workflows/README.md`](../.github/workflows/README.md) for setup instructions,
required secrets, and typical usage.

---

## Open Questions

1. ~~**Which locale to start with?**~~ Started with `zh-TW` (85K clips). Locale is now
   auto-detected from the archive — no manual selection needed.
2. ~~**Dataset version**~~ — Multiple versions supported. Version stored in both `datasets`
   and `clips` tables, parsed from archive directory name.
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
