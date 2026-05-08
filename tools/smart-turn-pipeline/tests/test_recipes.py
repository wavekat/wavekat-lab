from wkst.recipes import RECIPES, get, names


def test_baseline_and_specaugment_registered():
    assert set(names()) >= {"baseline", "specaugment"}


def test_baseline_has_no_augment():
    assert get("baseline").augment is None


def test_specaugment_has_default_masks():
    aug = get("specaugment").augment
    assert aug is not None
    assert aug.n_time_masks == 2
    assert aug.time_mask_max == 40
    assert aug.n_freq_masks == 2
    assert aug.freq_mask_max == 15


def test_unknown_recipe_raises():
    import pytest

    with pytest.raises(KeyError):
        get("does-not-exist")


def test_recipes_share_pinned_base_model():
    base_models = {r.base_model for r in RECIPES.values()}
    assert base_models == {"openai/whisper-tiny"}
