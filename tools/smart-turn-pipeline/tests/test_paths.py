from pathlib import Path

from wkst import _paths


def test_repo_root_honours_env(fake_repo: Path):
    assert _paths.repo_root() == fake_repo
    assert _paths.datasets_dir() == fake_repo / "datasets"
    assert _paths.snapshots_dir() == fake_repo / "snapshots"
    assert _paths.checkpoints_dir() == fake_repo / "checkpoints"
    assert _paths.smart_turn_module_dir() == fake_repo / "notebooks" / "smart-turn"


def test_repo_root_walks_up_to_real_root():
    """Without WKST_REPO_ROOT, walks up from the package to the lab repo."""
    import os

    saved = os.environ.pop("WKST_REPO_ROOT", None)
    try:
        root = _paths.repo_root()
        assert (root / "notebooks").is_dir()
        assert (root / "pyproject.toml").is_file()
    finally:
        if saved is not None:
            os.environ["WKST_REPO_ROOT"] = saved


def test_smart_turn_loader_finds_module(fake_repo: Path):
    """Stub smart_turn.py loads via the sys.path shim."""
    from wkst._smart_turn import load_smart_turn

    mod = load_smart_turn()
    assert mod.__file__.endswith("smart_turn.py")
