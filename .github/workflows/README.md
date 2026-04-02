# GitHub Actions Workflows

## CV: Provision Runner (`cv-runner-provision.yml`)

Spins up an ephemeral Azure VM as a self-hosted GitHub Actions runner.
The VM auto-shuts down after a configurable timeout. Zero idle cost.

**Inputs:**

| Input | Default | Description |
|-------|---------|-------------|
| `vm_size` | `Standard_D4s_v3` | Azure VM size (2/4/8 vCPU options) |
| `disk_size_gb` | `256` | OS disk size in GB |
| `max_hours` | `2` | Auto-shutdown after N hours |

### Setup guide — before first run

#### 1. Set your variables

```bash
# List available subscriptions — use the "id" field as SUBSCRIPTION_ID
az account list --output table

# Edit these to match your environment
SUBSCRIPTION_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
LOCATION="australiaeast"       # australiaeast, eastasia, japaneast, southeastasia, westus2, etc.
RESOURCE_GROUP="github-runner-rg"
```

#### 2. Create Azure resource group + service principal

```bash
az group create --name "$RESOURCE_GROUP" --location "$LOCATION"

az ad sp create-for-rbac \
  --name "github-cv-runner" \
  --role Contributor \
  --scopes "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP"
```

This outputs JSON like:

```json
{
  "appId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "displayName": "github-cv-runner",
  "password": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "tenant": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

For the `AZURE_CREDENTIALS` secret, build this JSON from the output:

```json
{
  "clientId": "<appId>",
  "clientSecret": "<password>",
  "subscriptionId": "<your SUBSCRIPTION_ID>",
  "tenantId": "<tenant>"
}
```

#### 3. Create GitHub PAT

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens:
- **Repository access:** this repo only
- **Permissions:** Administration (read/write) — needed to generate runner registration tokens

#### 4. Configure secrets and variables

Repo → Settings → Secrets and variables → Actions:

**Secrets** (sensitive):

| Secret | Value |
|--------|-------|
| `AZURE_CREDENTIALS` | JSON with `clientId`, `clientSecret`, `subscriptionId`, `tenantId` |
| `GH_PAT` | GitHub fine-grained PAT with admin permission |

**Variables** (non-sensitive):

| Variable | Value |
|----------|-------|
| `AZURE_RESOURCE_GROUP` | Resource group name (e.g. `github-runner-rg`) |
| `AZURE_LOCATION` | Azure region — must match the resource group location |

---

## CV: Dataset Sync (`cv-sync.yml`)

Runs the Common Voice dataset sync on the `cv-sync` runner (the Azure VM).
After sync completes, automatically deletes the VM.

**Inputs:**

| Input | Default | Description |
|-------|---------|-------------|
| `locale` | `en` | Common Voice locale (e.g. `en`, `ja`, `zh-TW`) |
| `split` | `validated` | Dataset split (`validated`, `train`, `dev`, `test`) |
| `version` | `cv-corpus-17.0-2024-03-15` | Common Voice version |

### Additional secrets (set up before first sync)

| Secret | Value |
|--------|-------|
| `DATACOLLECTIVE_API_KEY` | From datacollective.mozillafoundation.org → Profile → Credentials |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Account ID |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → API Tokens (needs D1 + R2) |
| `CV_EXPLORER_D1_ID` | After running `wrangler d1 create cv-explorer` |
| `CV_EXPLORER_R2_BUCKET` | After running `wrangler r2 bucket create cv-explorer` |

---

## Typical usage

```
1. Trigger "CV: Provision Runner" (pick VM size, disk, max hours)
2. Wait ~2 min for VM to come online
3. Trigger "CV: Dataset Sync" (pick locale, split, version)
4. Sync runs on the Azure VM
5. VM is deleted automatically after sync (or shuts down after max_hours)
```
