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
| `dataset_id` | *(required)* | Data Collective dataset ID (from the dataset URL) |

### Setup guide — before first sync

#### 1. Install Wrangler (Cloudflare CLI)

```bash
npm install -g wrangler

# Login to Cloudflare
wrangler login
```

This opens a browser to authenticate with your Cloudflare account.

#### 2. Create D1 database and R2 bucket

```bash
# Create the D1 database — note the database ID from the output
wrangler d1 create cv-explorer

# Create the R2 bucket
wrangler r2 bucket create cv-explorer
```

The `d1 create` output will look like:

```
✅ Successfully created DB 'cv-explorer'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Use that `database_id` as `CV_EXPLORER_D1_ID`.

#### 3. Create Cloudflare API token

Cloudflare dashboard → My Profile → API Tokens → Create Token → **Create Custom Token**:

Permissions (add all three):

| Scope | Resource | Permission |
|-------|----------|------------|
| Account | D1 | Edit |
| Account | R2 Storage | Edit |
| Account | Workers Scripts | Edit |

- **Account resources:** Include → your account
- **Zone resources:** can leave empty (not needed)

#### 4. Create R2 API token (S3-compatible)

> **Note:** R2 S3-compatible tokens can only be created via the Cloudflare dashboard —
> there is no `wrangler` command for this.

Cloudflare dashboard → Storage & Databases → R2 → **Manage R2 API Tokens** → Create API token:
- **Token name:** `cv-explorer-sync`
- **Permissions:** Object Read & Write
- **Bucket:** Apply to specific bucket → `cv-explorer`

After creating, you'll see an **Access Key ID** and **Secret Access Key**. Copy both
immediately — the secret is only shown once. These are separate from the Cloudflare API
token and are used for S3-compatible uploads to R2.

#### 5. Configure secrets and variables

**Secrets** (sensitive):

| Secret | Value |
|--------|-------|
| `DATACOLLECTIVE_API_KEY` | From datacollective.mozillafoundation.org → Profile → Credentials |
| `CLOUDFLARE_API_TOKEN` | The API token from step 3 (for D1) |
| `CV_EXPLORER_D1_ID` | Database ID from `wrangler d1 create` output |
| `R2_ACCESS_KEY_ID` | R2 API token Access Key ID from step 4 |
| `R2_SECRET_ACCESS_KEY` | R2 API token Secret Access Key from step 4 |

**Variables** (non-sensitive):

| Variable | Value |
|----------|-------|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Overview → Account ID (right sidebar) |
| `CV_EXPLORER_R2_BUCKET` | Bucket name: `cv-explorer` |

---

## Typical usage

```
1. Trigger "CV: Provision Runner" (pick VM size, disk, max hours)
2. Wait ~2 min for VM to come online
3. Trigger "CV: Dataset Sync" (pick locale, split, version)
4. Sync runs on the Azure VM
5. VM is deleted automatically after sync (or shuts down after max_hours)
```

---

## Useful commands

### Check runner VM status

```bash
# List all runner VMs
az vm list --resource-group github-runner-rg --output table

# Check power state of a specific VM
az vm get-instance-view \
  --resource-group github-runner-rg \
  --name cv-sync-1775172573 \
  --query "instanceView.statuses[1].displayStatus" \
  --output tsv
# Output: "VM running", "VM deallocated", "VM stopped", etc.

# Check the scheduled auto-shutdown inside the VM
az vm run-command invoke \
  --resource-group github-runner-rg \
  --name cv-sync-1775172573 \
  --command-id RunShellScript \
  --scripts "shutdown --show"
```

### Manually stop or delete a VM

```bash
# Stop (deallocate) — stops billing for compute, keeps the disk
az vm deallocate \
  --resource-group github-runner-rg \
  --name cv-sync-1775172573

# Delete — removes VM, disk, and NIC entirely
az vm delete \
  --resource-group github-runner-rg \
  --name cv-sync-1775172573 \
  --yes --force-deletion true

# Delete ALL runner VMs in the resource group
az vm list --resource-group github-runner-rg --query "[?starts_with(name, 'cv-sync-')].name" -o tsv | \
  xargs -I {} az vm delete --resource-group github-runner-rg --name {} --yes --force-deletion true
```

### Check GitHub runner registration

```bash
# List registered runners (requires GH_TOKEN or gh auth login)
gh api /repos/{owner}/{repo}/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```
