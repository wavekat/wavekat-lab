.PHONY: help install install-train test ci report

help:
	@echo "smart-turn-pipeline (wk-st)"
	@echo ""
	@echo "  install        Install the package (no torch — plumbing only)"
	@echo "  install-train  Install with the train extra (torch + transformers + onnx)"
	@echo "  test           Run the unit tests"
	@echo "  ci             Lint-light + test"
	@echo "  report         Rebuild notebooks/smart-turn/README.md scorecard from ledger"

install:
	uv pip install -e .

install-train:
	uv pip install -e .[train]

test:
	uv run --extra dev pytest

ci: test

report:
	uv run --extra dev python -m wkst report
