"""Recipe registry.

Add a new variant by dropping a module here that exposes a top-level
``RECIPE`` of type :class:`wkst.config.Recipe`, then registering it in
:data:`RECIPES`. The CLI's ``--recipe`` flag picks from this dict.
"""

from __future__ import annotations

from wkst.config import Recipe
from wkst.recipes.baseline import RECIPE as BASELINE
from wkst.recipes.specaugment import RECIPE as SPECAUGMENT

RECIPES: dict[str, Recipe] = {
    BASELINE.name: BASELINE,
    SPECAUGMENT.name: SPECAUGMENT,
}


def get(name: str) -> Recipe:
    try:
        return RECIPES[name]
    except KeyError as exc:
        raise KeyError(
            f"Unknown recipe {name!r}. Known: {sorted(RECIPES)}"
        ) from exc


def names() -> list[str]:
    return sorted(RECIPES)
