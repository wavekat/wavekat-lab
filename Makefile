.PHONY: help setup setup-notebooks lab \
        ci ci-audio-lab ci-cv-explorer \
        audio-lab cv-explorer

help:
	@echo "wavekat-lab — root targets (repo-wide). Per-tool targets live in each tool's Makefile."
	@echo ""
	@echo "Setup:"
	@echo "  setup              Install all tool dependencies + Jupyter env"
	@echo "  setup-notebooks    Install Jupyter notebook deps via uv"
	@echo ""
	@echo "Notebooks:"
	@echo "  lab                Start Jupyter Lab on notebooks/"
	@echo ""
	@echo "CI:"
	@echo "  ci                 Run CI for all tools"
	@echo "  ci-audio-lab       → make -C tools/audio-lab ci"
	@echo "  ci-cv-explorer     → make -C tools/cv-explorer ci  (cv-explorer's CI script)"
	@echo ""
	@echo "Per-tool development: cd into the tool and use its Makefile, e.g.:"
	@echo "  cd tools/audio-lab && make help"
	@echo "  cd tools/cv-explorer && make help"

# ─── Repo-wide setup ──────────────────────────────────────────────────────────

setup: setup-notebooks
	$(MAKE) -C tools/audio-lab install
	$(MAKE) -C tools/cv-explorer install

setup-notebooks:
	uv sync

# ─── Notebooks ────────────────────────────────────────────────────────────────

lab:
	uv run jupyter lab notebooks/

# ─── CI (delegates to each tool) ──────────────────────────────────────────────

ci: ci-audio-lab ci-cv-explorer

ci-audio-lab:
	$(MAKE) -C tools/audio-lab ci

ci-cv-explorer:
	cd tools/cv-explorer/worker && npm run typecheck
	cd tools/cv-explorer/web && npm run build
