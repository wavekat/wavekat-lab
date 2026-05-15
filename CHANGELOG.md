# Changelog

## [0.0.15](https://github.com/wavekat/wavekat-lab/compare/v0.0.14...v0.0.15) (2026-05-14)


### Features

* **audio-lab:** add wavekat-zh Smart Turn fine-tune as a second turn backend ([#44](https://github.com/wavekat/wavekat-lab/issues/44)) ([07f92c8](https://github.com/wavekat/wavekat-lab/commit/07f92c84999e393503c1ef60bf45defe7f8c8789))

## [0.0.14](https://github.com/wavekat/wavekat-lab/compare/v0.0.13...v0.0.14) (2026-05-11)


### Features

* **smart-turn:** wk-st publish — stage + push fine-tunes to HuggingFace ([a9a3a44](https://github.com/wavekat/wavekat-lab/commit/a9a3a44f4d039371715adf266bb5f3c42972bb3a))
* **smart-turn:** wk-st publish — stage + push fine-tunes to HuggingFace ([#42](https://github.com/wavekat/wavekat-lab/issues/42)) ([2d4ce7e](https://github.com/wavekat/wavekat-lab/commit/2d4ce7e78605e533f13f5c9f60a84de199810436))


### Bug Fixes

* **smart-turn:** enable constant folding so int8 quant actually shrinks the ONNX ([#43](https://github.com/wavekat/wavekat-lab/issues/43)) ([dc0ba56](https://github.com/wavekat/wavekat-lab/commit/dc0ba563821a09d2633b2384cc569a2aa2adb752))

## [0.0.13](https://github.com/wavekat/wavekat-lab/compare/v0.0.12...v0.0.13) (2026-05-10)


### Features

* **smart-turn:** persist PR/F1 curves ([#39](https://github.com/wavekat/wavekat-lab/issues/39)) ([810d284](https://github.com/wavekat/wavekat-lab/commit/810d2840e0e7d294827db3ab9ebe1cc4bc5a0912))
* **smart-turn:** pipeline wheel — wk-st CLI ([94d63d9](https://github.com/wavekat/wavekat-lab/commit/94d63d92dac39bf8f9f0ee224b713fb95bd23287))
* **smart-turn:** wk-st eval-pipecat — frozen pipecat-v3 with PR curves ([#40](https://github.com/wavekat/wavekat-lab/issues/40)) ([f187152](https://github.com/wavekat/wavekat-lab/commit/f1871521e3d9b9072d7002fa979e3a82d78fe022))

## [0.0.12](https://github.com/wavekat/wavekat-lab/compare/v0.0.11...v0.0.12) (2026-05-04)


### Features

* **smart-turn:** mining uploads + zh-0503 bump ([def89be](https://github.com/wavekat/wavekat-lab/commit/def89beeb09df5377f44a54669181fb527e1ad59))
* **smart-turn:** RAMC mining + 0501/0502 models ([#33](https://github.com/wavekat/wavekat-lab/issues/33)) ([8d22bdf](https://github.com/wavekat/wavekat-lab/commit/8d22bdf08d7411c4df045307d1f2ee22249ccd23))

## [0.0.11](https://github.com/wavekat/wavekat-lab/compare/v0.0.10...v0.0.11) (2026-04-30)


### Features

* add smart-turn load notebook ([#28](https://github.com/wavekat/wavekat-lab/issues/28)) ([a64f70a](https://github.com/wavekat/wavekat-lab/commit/a64f70ac1526798288023cdaa038a6df7b95403f))
* smart-turn ZH train + eval pipeline ([#30](https://github.com/wavekat/wavekat-lab/issues/30)) ([23b58ec](https://github.com/wavekat/wavekat-lab/commit/23b58ec4c61ad916f01bfc7a399b98d631295cd5))

## [0.0.10](https://github.com/wavekat/wavekat-lab/compare/v0.0.9...v0.0.10) (2026-04-04)


### Features

* add Common Voice Explorer ([#24](https://github.com/wavekat/wavekat-lab/issues/24)) ([86fd2c5](https://github.com/wavekat/wavekat-lab/commit/86fd2c56aee282b5c75a5b13d2ab77bc0802c2dc))

## [0.0.9](https://github.com/wavekat/wavekat-lab/compare/v0.0.8...v0.0.9) (2026-03-31)


### Features

* add pipeline reset mode config ([#21](https://github.com/wavekat/wavekat-lab/issues/21)) ([e5fce45](https://github.com/wavekat/wavekat-lab/commit/e5fce453526b547acf91e2c2fbae4e533e2d9f8b))

## [0.0.8](https://github.com/wavekat/wavekat-lab/compare/v0.0.7...v0.0.8) (2026-03-30)


### Features

* add RTF display with tooltip to pipeline mode ([#17](https://github.com/wavekat/wavekat-lab/issues/17)) ([6e72f97](https://github.com/wavekat/wavekat-lab/commit/6e72f9766881dc89d9dc62944d154e35636a7215))


### Bug Fixes

* make pipeline mode results deterministic ([#19](https://github.com/wavekat/wavekat-lab/issues/19)) ([c36cbe3](https://github.com/wavekat/wavekat-lab/commit/c36cbe319a82b5b9ddec0a6f5e2cab0a703ca932))

## [0.0.7](https://github.com/wavekat/wavekat-lab/compare/v0.0.6...v0.0.7) (2026-03-30)


### Features

* add wavekat.com link and footer ([#15](https://github.com/wavekat/wavekat-lab/issues/15)) ([6aac74e](https://github.com/wavekat/wavekat-lab/commit/6aac74e447aacd5f169bdc4196b209d7d53a372f))

## [0.0.6](https://github.com/wavekat/wavekat-lab/compare/v0.0.5...v0.0.6) (2026-03-29)


### Bug Fixes

* update Cargo.lock after release-please version bump ([#12](https://github.com/wavekat/wavekat-lab/issues/12)) ([a0503a4](https://github.com/wavekat/wavekat-lab/commit/a0503a4fa16a5778160986465bc60fba02b9f7bd))
* use cargo update --workspace to avoid bumping all deps ([#14](https://github.com/wavekat/wavekat-lab/issues/14)) ([aa11a6a](https://github.com/wavekat/wavekat-lab/commit/aa11a6ad1258f7ca60f4ff0d1d02ceb481cec181))

## [0.0.5](https://github.com/wavekat/wavekat-lab/compare/v0.0.4...v0.0.5) (2026-03-29)


### Features

* VAD-gated pipeline mode ([#10](https://github.com/wavekat/wavekat-lab/issues/10)) ([4aaf8f4](https://github.com/wavekat/wavekat-lab/commit/4aaf8f4320825c2b1f40f414bf5c09c77f438430))

## [0.0.4](https://github.com/wavekat/wavekat-lab/compare/v0.0.3...v0.0.4) (2026-03-28)


### Features

* turn detection lab ([#8](https://github.com/wavekat/wavekat-lab/issues/8)) ([495499c](https://github.com/wavekat/wavekat-lab/commit/495499cbba126fc57a40999f95bb21a90786508c))

## [0.0.3](https://github.com/wavekat/wavekat-lab/compare/v0.0.2...v0.0.3) (2026-03-28)


### Features

* rename vad-lab to lab ([#6](https://github.com/wavekat/wavekat-lab/issues/6)) ([c6bce85](https://github.com/wavekat/wavekat-lab/commit/c6bce8525932d4239bea99330c0d65598a7fced6))

## [0.0.2](https://github.com/wavekat/wavekat-lab/compare/v0.0.1...v0.0.2) (2026-03-27)


### Features

* migrate vad-lab from wavekat-vad ([#1](https://github.com/wavekat/wavekat-lab/issues/1)) ([5a00c18](https://github.com/wavekat/wavekat-lab/commit/5a00c18eff99c21ee13ae7623c1b7f78072b61ca))
