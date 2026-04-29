# smart-turn docs

Strategy and progress for the Chinese turn-detection model.

| File | Purpose |
|---|---|
| [`MISSION.md`](MISSION.md) | North star — what "best zh turn detector" means and the v1 ship bar. Stable; rarely edited. |
| [`01-measurement.md`](01-measurement.md) | Trustworthy eval (seeds, bootstrap CI, larger test set). Blocks everything else. |
| [`02-warmstart.md`](02-warmstart.md) | Cheap baselines: warm-start from `smart-turn-v3`, audio augmentation. |
| [`03-tts-synthesis.md`](03-tts-synthesis.md) | TTS-bootstrapped data scale-up to 10k → 50k. The big bet. |

Numbered files are work in roughly sequential order. Each has a goal,
checklist, exit criteria, and a `Results` section to fill in as it
runs. Add `04-...md`, `05-...md` for whatever comes next.

The notebook-level [`../README.md`](../README.md) keeps the at-a-glance
scorecard table and how-to-run instructions.
