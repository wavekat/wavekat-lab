.PHONY: help install install-train install-publish test ci report publish-dry

help:
	@echo "smart-turn-pipeline (wk-st)"
	@echo ""
	@echo "  install         Install the package (no torch — plumbing only)"
	@echo "  install-train   Install with the train extra (torch + transformers + onnx)"
	@echo "  install-publish Install with the publish extra (huggingface_hub)"
	@echo "  test            Run the unit tests"
	@echo "  ci              Lint-light + test"
	@echo "  report          Rebuild notebooks/smart-turn/README.md scorecard from ledger"
	@echo "  publish-dry     Stage CKPT (no upload). Vars: CKPT=<dir> LANG=zh [ONNX=<path>]"

install:
	uv pip install -e .

install-train:
	uv pip install -e .[train]

install-publish:
	uv pip install -e .[publish]

test:
	uv run --extra dev pytest

ci: test

report:
	uv run --extra dev python -m wkst report

# Dry-run publish target. Stages files into <CKPT>/publish/ without
# touching HuggingFace. Run with e.g.:
#   make publish-dry CKPT=../../checkpoints/<run> LANG=zh
# To actually upload, run `wk-st publish --checkpoint ... --lang ... --upload`
# with HF_TOKEN set (the workflow at .github/workflows/publish-smart-turn.yml
# is the supported path in CI).
publish-dry:
	@if [ -z "$(CKPT)" ] || [ -z "$(LANG)" ]; then \
		echo "usage: make publish-dry CKPT=<checkpoint-dir> LANG=<code> [ONNX=<override>]"; \
		exit 2; \
	fi
	uv run --extra publish python -m wkst publish \
		--checkpoint "$(CKPT)" \
		--lang "$(LANG)" \
		$(if $(ONNX),--onnx "$(ONNX)",)
