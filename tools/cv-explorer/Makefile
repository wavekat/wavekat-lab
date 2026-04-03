SHELL := /bin/bash
NVM   := source $$NVM_DIR/nvm.sh && nvm use 22 --silent &&

.PHONY: install dev dev-worker dev-web build deploy migrate-local sync

# ---------- Install ----------

install:
	$(NVM) cd worker && npm install
	$(NVM) cd web && npm install
	$(NVM) cd scripts && npm install

# ---------- Local dev ----------

dev:
	@echo "Starting worker on :8787 and web on :5173..."
	@trap 'kill 0' EXIT; \
		source $$NVM_DIR/nvm.sh && nvm use 22 --silent && \
		cd worker && npx wrangler dev & \
		source $$NVM_DIR/nvm.sh && nvm use 22 --silent && \
		cd web && npx vite & \
		wait

dev-worker:
	$(NVM) cd worker && npx wrangler dev

dev-web:
	$(NVM) cd web && npx vite

migrate-local:
	$(NVM) cd worker && npx wrangler d1 migrations apply cv-explorer --local

# ---------- Sync (populate D1 + R2) ----------
# Loads env from .env — copy .env.example to .env and fill in values.
# Runs against REMOTE Cloudflare by default (same as CI).

sync:
	@test -f .env || (echo "Missing .env — copy .env.example to .env first" && exit 1)
	$(NVM) cd scripts && set -a && source ../.env && set +a && \
		npx tsx sync.ts $(ARGS)

# ---------- Production ----------

build:
	$(NVM) cd web && npm run build

deploy:
	$(NVM) cd worker && npx wrangler deploy

migrate-remote:
	$(NVM) cd worker && npx wrangler d1 migrations apply cv-explorer --remote
