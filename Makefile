.PHONY: help setup setup-backend setup-frontend dev dev-frontend dev-backend check test fmt lint ci ci-backend ci-frontend ci-cv-explorer

help:
	@echo "Available targets:"
	@echo "  setup           Install all dependencies (run once after clone)"
	@echo "  setup-backend   Install cargo-watch"
	@echo "  setup-frontend  Install npm dependencies"
	@echo "  dev-backend     Run lab backend with auto-rebuild"
	@echo "  dev-frontend    Run lab frontend dev server"
	@echo "  dev             Instructions for running both"
	@echo "  check           Check workspace compiles"
	@echo "  test            Run all tests"
	@echo "  fmt             Format code"
	@echo "  lint            Run clippy with warnings as errors"
	@echo "  ci              Run all CI checks (backend + frontend)"
	@echo "  ci-backend      Run backend CI checks (fmt, clippy, test)"
	@echo "  ci-frontend     Run frontend CI checks (lint, build)"

# Install all dependencies
setup: setup-backend setup-frontend

# Install cargo-watch for auto-rebuild
setup-backend:
	cargo install cargo-watch

# Install frontend npm dependencies
setup-frontend:
	cd frontend && . "$$NVM_DIR/nvm.sh" && nvm use && npm install

# Run lab backend with auto-rebuild on file changes
dev-backend:
	cargo watch -x 'run -p lab'

# Run lab frontend dev server (uses .nvmrc for Node version)
dev-frontend:
	cd frontend && . "$$NVM_DIR/nvm.sh" && nvm use && npm run dev

# Run both frontend and backend (requires two terminals — use dev-backend + dev-frontend)
dev:
	@echo "Run 'make dev-backend' and 'make dev-frontend' in separate terminals"

# Check workspace compiles
check:
	cargo check --workspace

# Run all tests
test:
	cargo test --workspace

# Format code
fmt:
	cargo fmt --all

# Lint
lint:
	cargo clippy --workspace -- -D warnings

# Run all CI checks (backend + frontend)
ci: ci-backend ci-frontend

# Run backend CI checks (fmt, clippy, test)
ci-backend:
	cargo fmt --all -- --check
	cargo clippy --workspace -- -D warnings
	cargo test --workspace

# Run frontend CI checks (lint, build) — run setup-frontend first if deps are missing
ci-frontend:
	cd frontend && npm run lint && npm run build

# Run CV Explorer CI checks (typecheck worker + build web)
ci-cv-explorer:
	cd tools/cv-explorer/worker && npm run typecheck
	cd tools/cv-explorer/web && npm run build
