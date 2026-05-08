.PHONY: help install install-train test ci

help:
	@echo "smart-turn-pipeline (wk-st)"
	@echo ""
	@echo "  install        Install the package (no torch — plumbing only)"
	@echo "  install-train  Install with the train extra (torch + transformers)"
	@echo "  test           Run the unit tests"
	@echo "  ci             Lint-light + test"

install:
	uv pip install -e .

install-train:
	uv pip install -e .[train]

test:
	uv run --extra dev pytest

ci: test
