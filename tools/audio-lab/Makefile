SHELL := /bin/bash
NVM   := source $$NVM_DIR/nvm.sh && nvm use --silent &&

.PHONY: help \
        install install-backend install-frontend \
        dev dev-backend dev-frontend \
        check test fmt lint \
        ci ci-backend ci-frontend

help:
	@echo "audio-lab — VAD + Turn Detection real-time testing app"
	@echo ""
	@echo "Setup:"
	@echo "  install            Install backend (cargo-watch) and frontend (npm) deps"
	@echo "  install-backend    Install cargo-watch"
	@echo "  install-frontend   Install npm dependencies (uses .nvmrc)"
	@echo ""
	@echo "Development:"
	@echo "  dev-backend        Run backend with auto-rebuild"
	@echo "  dev-frontend       Run frontend dev server"
	@echo ""
	@echo "Quality:"
	@echo "  check              Check workspace compiles"
	@echo "  test               Run all tests"
	@echo "  fmt                Format code"
	@echo "  lint               Run clippy with warnings as errors"
	@echo ""
	@echo "CI:"
	@echo "  ci                 Run all CI checks (backend + frontend)"
	@echo "  ci-backend         Run backend CI checks (fmt, clippy, test)"
	@echo "  ci-frontend        Run frontend CI checks (lint, build)"

# ─── Setup ────────────────────────────────────────────────────────────────────

install: install-backend install-frontend

install-backend:
	cargo install cargo-watch

install-frontend:
	$(NVM) cd frontend && npm install

# ─── Development ──────────────────────────────────────────────────────────────

dev-backend:
	cargo watch -x 'run -p audio-lab'

dev-frontend:
	$(NVM) cd frontend && npm run dev

dev:
	@echo "Run 'make dev-backend' and 'make dev-frontend' in separate terminals"

# ─── Quality ──────────────────────────────────────────────────────────────────

check:
	cargo check --workspace

test:
	cargo test --workspace

fmt:
	cargo fmt --all

lint:
	cargo clippy --workspace -- -D warnings

# ─── CI ───────────────────────────────────────────────────────────────────────

ci: ci-backend ci-frontend

ci-backend:
	cargo fmt --all -- --check
	cargo clippy --workspace -- -D warnings
	cargo test --workspace

ci-frontend:
	cd frontend && npm run lint && npm run build
