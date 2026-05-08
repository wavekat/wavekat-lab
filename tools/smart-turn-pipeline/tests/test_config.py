from pathlib import Path

from wkst.config import Recipe, RunConfig, SpecAugmentCfg


def test_recipe_serialises_round_trip():
    r = Recipe(name="x", augment=SpecAugmentCfg(n_time_masks=1))
    data = r.as_dict()
    assert data["name"] == "x"
    assert data["augment"]["n_time_masks"] == 1


def test_recipe_default_augment_is_none():
    assert Recipe(name="baseline").augment is None


def test_run_config_serialises_paths_as_strings():
    cfg = RunConfig(
        recipe=Recipe(name="baseline"),
        dataset_dir=Path("/tmp/ds"),
        checkpoint_dir=Path("/tmp/ckpt"),
        run_name="baseline",
        dataset_name="smart-turn-zh-0503",
        export_id="abc123",
    )
    data = cfg.as_dict()
    assert data["dataset_dir"] == "/tmp/ds"
    assert data["test_dir"] is None
    assert data["export_id"] == "abc123"
    assert data["recipe"]["name"] == "baseline"
