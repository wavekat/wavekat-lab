# CV Explorer

A web app for browsing and playing audio clips from the [Mozilla Common Voice](https://commonvoice.mozilla.org) dataset. Filter by locale, split, demographics, and more.

## Demo

[![Common Voice Explorer Demo](https://img.youtube.com/vi/8IScEH0ZJxA/0.jpg)](https://youtu.be/8IScEH0ZJxA)

## Architecture

```
web/       React 19 + Vite + Tailwind CSS (frontend)
worker/    Cloudflare Worker + Hono (API)
scripts/   Dataset sync script (Node.js)
```

| Service   | Platform       |
|-----------|----------------|
| Compute   | Cloudflare Workers |
| Database  | Cloudflare D1 (SQLite) |
| Storage   | Cloudflare R2 |
| Auth      | GitHub OAuth |

## Local development

### Prerequisites

- Node.js 22 (via nvm)
- A [GitHub OAuth App](https://github.com/settings/developers) with callback URL `http://localhost:5174/auth/callback`

### Setup

```bash
cp .env.example .env
# Fill in: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, JWT_SECRET
make install
make migrate-local
make dev
```

This starts the worker on `:8787` and the web dev server on `:5174` (proxies `/api` to the worker).

## Deployment

Deployment is handled by GitHub Actions. Pushing to `main` with changes under `tools/cv-explorer/worker/` or `tools/cv-explorer/web/` triggers the **CV Explorer: Deploy** workflow, which builds the frontend, runs D1 migrations, and deploys the worker with static assets.

You can also trigger a deploy manually from the Actions tab (`workflow_dispatch`).

### First-time setup

#### 1. Cloudflare resources

The D1 database and R2 bucket are already provisioned (see `worker/wrangler.toml`). If starting fresh:

```bash
cd worker
npx wrangler d1 create cv-explorer
npx wrangler r2 bucket create cv-explorer
```

Update `database_id` in `wrangler.toml` with the new D1 ID.

#### 2. GitHub OAuth App (production)

Create a new OAuth App at https://github.com/settings/developers:

- **Homepage URL**: your Worker URL (e.g. `https://cv-explorer-api.<subdomain>.workers.dev`)
- **Callback URL**: `https://cv-explorer-api.<subdomain>.workers.dev/auth/callback`

Set the client ID in `worker/wrangler.toml`:

```toml
[vars]
GITHUB_CLIENT_ID = "<production-client-id>"
```

#### 3. Worker secrets

Set secrets that the Worker reads at runtime:

```bash
cd worker
npx wrangler secret put GITHUB_CLIENT_SECRET   # from the OAuth App above
npx wrangler secret put JWT_SECRET              # any random string (e.g. openssl rand -hex 32)
```

#### 4. GitHub Actions secrets and variables

Configure these in your repo under **Settings > Secrets and variables > Actions**:

| Type     | Name                    | Description |
|----------|-------------------------|-------------|
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| Secret   | `CLOUDFLARE_API_TOKEN`  | API token with Workers/D1/R2 permissions |

These are shared with the `CV: Dataset Sync` workflow and may already be set.

## Data sync

Audio clips and metadata are synced from the [Mozilla Data Collective API](https://datacollective.mozillafoundation.org) into D1 + R2.

### Via GitHub Actions (recommended)

Use the **CV: Dataset Sync** workflow from the Actions tab. Required inputs:

- **dataset_id**: from the Data Collective URL
- **split**: `all`, `validated`, `train`, `dev`, `test`, etc.

The workflow needs these additional secrets beyond the deploy ones:

| Type     | Name                      | Description |
|----------|---------------------------|-------------|
| Secret   | `DATACOLLECTIVE_API_KEY`  | Mozilla Data Collective API key |
| Secret   | `CV_EXPLORER_D1_ID`       | D1 database ID |
| Secret   | `R2_ACCESS_KEY_ID`        | R2 S3-compatible access key |
| Secret   | `R2_SECRET_ACCESS_KEY`    | R2 S3-compatible secret key |
| Variable | `CV_EXPLORER_R2_BUCKET`   | R2 bucket name |

### Locally

```bash
# Fill in Cloudflare credentials in .env (see .env.example)
make sync ARGS="--dataset-id <id> --split all --r2-concurrency 32"
```

## API endpoints

All data endpoints require authentication (GitHub OAuth) and terms acceptance.

| Method | Path             | Auth | Description |
|--------|------------------|------|-------------|
| GET    | `/api/auth/config` | No  | Get GitHub client ID |
| POST   | `/api/auth/github` | No  | Exchange OAuth code for tokens |
| POST   | `/api/auth/refresh` | No | Refresh access token |
| POST   | `/api/auth/terms` | Yes  | Accept terms of use |
| GET    | `/api/auth/me`   | Yes  | Get current user |
| POST   | `/api/auth/logout` | No | Revoke refresh token |
| GET    | `/api/datasets`  | Yes  | List synced datasets |
| GET    | `/api/stats`     | Yes  | Clip counts by locale/split |
| GET    | `/api/clips`     | Yes  | Search/filter clips |
| GET    | `/api/audio/*`   | Yes  | Stream audio from R2 |
