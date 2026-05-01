# smart-turn docs

Strategy and progress for the Chinese turn-detection model.

| File | Purpose |
|---|---|
| [`MISSION.md`](MISSION.md) | North star — what "best zh turn detector" means and the v1 ship bar. Stable; rarely edited. |
| [`02-more-data.md`](02-more-data.md) | Plan to scale from ~1K to 10K+ labeled samples: mining real zh conversation corpora (plan A), TTS synthesis (plan B), human labeling on product audio, active learning. |
| [`03-magicdata-ramc-mining.md`](03-magicdata-ramc-mining.md) | Concrete pipeline for Tier 1: turn RAMC's diarized TXT + WAV into labeled clips via consensus of structural label + VAD + own model + LLM, routed to a wavekat-platform review project. |
| [`04-0501-0502-models.md`](04-0501-0502-models.md) | First two real-data model versions (`smart-turn-zh-0501`, `0502`), the AP regression we observed across them, why the comparison isn't apples-to-apples (test split changed), and the queued next steps: freeze a real-distribution test set, cross-eval, broaden mining sources beyond uncertainty. |

Numbered files are work in roughly sequential order. Each has a goal,
checklist, exit criteria, and a `Results` section to fill in as it
runs. Add `04-...md`, `05-...md` for whatever comes next.

The notebook-level [`../README.md`](../README.md) keeps the at-a-glance
scorecard table and how-to-run instructions.
