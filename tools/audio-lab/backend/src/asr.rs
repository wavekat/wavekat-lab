use crate::audio_source::AudioFrame;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};
use wavekat_asr::backends::r2t2::{
    self, R2t2Asr, R2t2Config, R2t2Model, R2t2Stats, R2t2Weights, R2T2_F16, R2T2_Q4_K_M, R2T2_Q8_0,
};
use wavekat_asr::backends::sherpa_onnx::{
    ModelPreset, SherpaOnnxAsr, BILINGUAL_ZH_EN, PARAFORMER_BILINGUAL_ZH_EN, PARAFORMER_ZH,
    ZIPFORMER_EN,
};
use wavekat_asr::{
    AsrError, AudioFrame as AsrAudioFrame, Channel, DownloadSource, StreamingAsr, TranscriptEvent,
};

/// Canonical preset names (the wire values used by the frontend).
pub const PRESET_NAMES: &[&str] = &["bilingual", "en", "zh", "paraformer-zh-en"];

/// R2T2 weight variants (the `weights` param's wire values). Their cache
/// keys are prefixed with `r2t2-` so they share the preset cache/preload
/// plumbing with sherpa-onnx without colliding.
pub const R2T2_WEIGHT_NAMES: &[&str] = &["q8", "q4", "f16"];
const R2T2_KEY_PREFIX: &str = "r2t2-";

/// ASR target sample rate. Both backends want 16 kHz f32.
const ASR_RATE: u32 = 16_000;

/// How often R2T2 performance stats are pushed to the frontend.
const STATS_INTERVAL: Duration = Duration::from_millis(300);

/// Configuration for a single ASR instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrConfig {
    /// Unique identifier for this config.
    pub id: String,
    /// Human-readable label.
    pub label: String,
    /// Backend name: "sherpa-onnx" or "r2t2".
    pub backend: String,
    /// Backend-specific parameters (e.g. `{"preset": "bilingual"}`).
    pub params: HashMap<String, serde_json::Value>,
}

/// One transcript event tagged with the config that produced it.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AsrServerEvent {
    /// ASR backend has finished initialising (model loaded). Sent once
    /// per config at startup so the frontend can move past "loading model…".
    Ready {
        config_id: String,
    },
    SpeechStarted {
        config_id: String,
        ts_ms: f64,
    },
    SpeechEnded {
        config_id: String,
        ts_ms: f64,
    },
    Partial {
        config_id: String,
        ts_ms: f64,
        text: String,
    },
    Final {
        config_id: String,
        ts_ms: f64,
        end_ms: f64,
        text: String,
        confidence: f32,
    },
    Warning {
        config_id: String,
        message: String,
    },
    /// Decode performance for backends that report it (R2T2).
    Stats {
        config_id: String,
        stats: AsrStats,
    },
}

/// Decode performance counters, flattened for the wire.
#[derive(Debug, Clone, Serialize)]
pub struct AsrStats {
    pub decode_steps: u64,
    pub merged_steps: u64,
    pub last_step_ms: f64,
    pub mean_step_ms: f64,
    pub max_step_ms: f64,
    pub rtf: f64,
    pub last_lag_ms: f64,
    pub mean_lag_ms: f64,
    pub max_lag_ms: f64,
    pub backlog_ms: f64,
    pub utterances: u64,
    pub language: String,
}

impl From<R2t2Stats> for AsrStats {
    fn from(s: R2t2Stats) -> Self {
        Self {
            decode_steps: s.decode_steps,
            merged_steps: s.merged_steps,
            last_step_ms: s.last_step_ms,
            mean_step_ms: s.mean_step_ms,
            max_step_ms: s.max_step_ms,
            rtf: s.rtf,
            last_lag_ms: s.last_lag_ms,
            mean_lag_ms: s.mean_lag_ms,
            max_lag_ms: s.max_lag_ms,
            backlog_ms: s.backlog_ms,
            utterances: s.utterances,
            language: s.language,
        }
    }
}

/// Pick a `ModelPreset` from a preset name string.
fn pick_preset(preset: &str) -> ModelPreset {
    match preset {
        "" | "bilingual" | "bilingual-zh-en" => BILINGUAL_ZH_EN,
        "en" | "english" | "zipformer-en" => ZIPFORMER_EN,
        "zh" | "chinese" | "paraformer-zh" => PARAFORMER_ZH,
        "paraformer-zh-en" | "paraformer-bilingual" => PARAFORMER_BILINGUAL_ZH_EN,
        _ => BILINGUAL_ZH_EN,
    }
}

/// Root of the HuggingFace Hub cache, honouring `HF_HOME` like hf-hub does.
fn hf_hub_cache_root() -> PathBuf {
    if let Ok(p) = std::env::var("HF_HOME") {
        return PathBuf::from(p).join("hub");
    }
    if let Ok(p) = std::env::var("HUGGINGFACE_HUB_CACHE") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".cache/huggingface/hub")
}

/// Convert an HF model id like `org/name` into the on-disk folder name
/// (`models--org--name`) used inside `$HF_HOME/hub/`.
fn model_dir_name(model_id: &str) -> String {
    format!("models--{}", model_id.replace('/', "--"))
}

/// Check whether all files of a preset are present in the HF cache.
///
/// Looks for any snapshot under `$HF_HOME/hub/models--{id}/snapshots/*` that
/// contains every file we'd download. Cheap (no model load, no network).
fn preset_cached(preset: &ModelPreset) -> bool {
    let model_root = hf_hub_cache_root().join(model_dir_name(preset.model_id));
    let snapshots = model_root.join("snapshots");
    let Ok(entries) = std::fs::read_dir(&snapshots) else {
        return false;
    };
    let mut required: Vec<&'static str> = vec![preset.encoder, preset.decoder, preset.tokens];
    if let Some(j) = preset.joiner {
        required.push(j);
    }
    for entry in entries.flatten() {
        let snap = entry.path();
        if required.iter().all(|f| snap.join(f).exists()) {
            return true;
        }
    }
    false
}

/// Pick R2T2 weights from the `weights` param value.
fn pick_r2t2_weights(name: &str) -> R2t2Weights {
    match name {
        "q4" => R2T2_Q4_K_M,
        "f16" => R2T2_F16,
        _ => R2T2_Q8_0,
    }
}

/// Cache state for every published preset, keyed by canonical preset name
/// (R2T2 weights as `r2t2-<weights>`).
pub fn cache_status_all() -> HashMap<String, bool> {
    let mut out = HashMap::new();
    for &name in PRESET_NAMES {
        out.insert(name.to_string(), preset_cached(&pick_preset(name)));
    }
    for &name in R2T2_WEIGHT_NAMES {
        out.insert(
            format!("{R2T2_KEY_PREFIX}{name}"),
            pick_r2t2_weights(name).is_cached(),
        );
    }
    out
}

/// Loaded R2T2 language models, kept for the life of the process so a new
/// recording doesn't reload ~2 GB of weights. Keyed by model filename.
fn shared_r2t2_model(config: &R2t2Config) -> Result<Arc<R2t2Model>, AsrError> {
    static MODELS: OnceLock<Mutex<HashMap<&'static str, Arc<R2t2Model>>>> = OnceLock::new();
    let models = MODELS.get_or_init(Default::default);
    // Held across the load so two configs with the same weights don't
    // both load them.
    let mut models = models.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(model) = models.get(config.weights.model.name) {
        return Ok(model.clone());
    }
    let model = R2t2Asr::load_model(config)?;
    models.insert(config.weights.model.name, model.clone());
    Ok(model)
}

/// Build an R2T2 config from the frontend params. `realtime` enables
/// catch-up (merging queued chunks when decoding falls behind) — right for
/// live capture; file analysis runs the reference's fixed schedule.
fn r2t2_config(params: &HashMap<String, serde_json::Value>, realtime: bool) -> R2t2Config {
    let str_param = |name: &str| params.get(name).and_then(|v| v.as_str()).unwrap_or("");
    let language = match str_param("language") {
        "" | "auto" => None,
        lang => Some(lang.to_string()),
    };
    R2t2Config {
        weights: pick_r2t2_weights(str_param("weights")),
        chunk_ms: str_param("chunk_ms").parse().unwrap_or(160),
        language,
        catch_up: realtime,
        ..R2t2Config::default()
    }
}

/// Preload event sent back to the frontend during a manual download.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AsrPreloadEvent {
    /// Loading has started (download may follow).
    Started { preset: String },
    /// Model files are on disk and the model loaded successfully.
    Completed { preset: String },
    /// Load failed; subsequent record attempts will likely fail too.
    Error { preset: String, message: String },
}

/// Spawn a worker thread that loads (and downloads, if needed) the given
/// preset, then drops the model. The point is to seed the HF cache so the
/// next real recording session starts instantly.
///
/// Returns immediately; events flow on the returned receiver.
pub fn preload_preset(preset_name: String) -> mpsc::Receiver<AsrPreloadEvent> {
    if let Some(weights) = preset_name.strip_prefix(R2T2_KEY_PREFIX) {
        return preload_r2t2(preset_name.clone(), pick_r2t2_weights(weights));
    }
    let (tx, rx) = mpsc::channel::<AsrPreloadEvent>(8);
    let preset = pick_preset(&preset_name);

    std::thread::Builder::new()
        .name(format!("asr-preload-{preset_name}"))
        .spawn(move || {
            let _ = tx.blocking_send(AsrPreloadEvent::Started {
                preset: preset_name.clone(),
            });
            tracing::info!(preset = %preset_name, "preloading sherpa-onnx model");

            match SherpaOnnxAsr::with_preset(preset) {
                Ok((asr, _rx)) => {
                    drop(asr);
                    tracing::info!(preset = %preset_name, "preload complete");
                    let _ = tx.blocking_send(AsrPreloadEvent::Completed {
                        preset: preset_name,
                    });
                }
                Err(e) => {
                    tracing::warn!(preset = %preset_name, "preload failed: {e}");
                    let _ = tx.blocking_send(AsrPreloadEvent::Error {
                        preset: preset_name,
                        message: e.to_string(),
                    });
                }
            }
        })
        .expect("spawn asr preload thread");

    rx
}

/// Download (and SHA-256-verify) R2T2 weights into the HF cache without
/// loading them. Same event protocol as [`preload_preset`].
fn preload_r2t2(key: String, weights: R2t2Weights) -> mpsc::Receiver<AsrPreloadEvent> {
    let (tx, rx) = mpsc::channel::<AsrPreloadEvent>(8);
    std::thread::Builder::new()
        .name(format!("asr-preload-{key}"))
        .spawn(move || {
            let _ = tx.blocking_send(AsrPreloadEvent::Started {
                preset: key.clone(),
            });
            tracing::info!(preset = %key, "downloading R2T2 weights");
            let result = r2t2::download_weights_to_cache(
                &weights,
                &[DownloadSource::hugging_face()],
                |_| {},
            );
            let evt = match result {
                Ok(_) => AsrPreloadEvent::Completed { preset: key },
                Err(e) => AsrPreloadEvent::Error {
                    preset: key,
                    message: e.to_string(),
                },
            };
            let _ = tx.blocking_send(evt);
        })
        .expect("spawn asr preload thread");
    rx
}

/// A constructed backend. R2T2 is kept concrete so its decode stats can be
/// read; everything else goes through the trait.
enum Backend {
    Sherpa(SherpaOnnxAsr),
    R2t2(R2t2Asr),
}

impl Backend {
    fn asr(&mut self) -> &mut dyn StreamingAsr {
        match self {
            Backend::Sherpa(a) => a,
            Backend::R2t2(a) => a,
        }
    }

    fn stats(&self) -> Option<R2t2Stats> {
        match self {
            Backend::Sherpa(_) => None,
            Backend::R2t2(a) => Some(a.stats()),
        }
    }
}

/// Construct the backend a config asks for (loading / downloading its
/// model). Runs on the config's worker thread.
fn build_backend(
    config: &AsrConfig,
    realtime: bool,
) -> Result<(Backend, std::sync::mpsc::Receiver<TranscriptEvent>), String> {
    match config.backend.as_str() {
        "sherpa-onnx" => {
            let preset_name = config
                .params
                .get("preset")
                .and_then(|v| v.as_str())
                .unwrap_or("bilingual");
            SherpaOnnxAsr::with_preset(pick_preset(preset_name))
                .map(|(asr, rx)| (Backend::Sherpa(asr), rx))
                .map_err(|e| e.to_string())
        }
        "r2t2" => {
            let cfg = r2t2_config(&config.params, realtime);
            let model = shared_r2t2_model(&cfg).map_err(|e| e.to_string())?;
            R2t2Asr::with_model(model, cfg)
                .map(|(asr, rx)| (Backend::R2t2(asr), rx))
                .map_err(|e| e.to_string())
        }
        other => Err(format!("unknown ASR backend `{other}`")),
    }
}

/// Linear-interpolation resample of f32 samples. Matches the quality of the
/// resampler used in `pipeline.rs` for VAD; adequate for a lab tool. If WER
/// regressions show up, swap for rubato + a higher-quality kernel.
fn resample_linear_f32(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let output_len = (samples.len() as f64 * ratio).round() as usize;
    let mut output = Vec::with_capacity(output_len);
    for i in 0..output_len {
        let src_pos = i as f64 / ratio;
        let src_idx = src_pos as usize;
        let frac = (src_pos - src_idx as f64) as f32;
        let s0 = samples[src_idx.min(samples.len() - 1)];
        let s1 = samples[(src_idx + 1).min(samples.len() - 1)];
        output.push(s0 + frac * (s1 - s0));
    }
    output
}

/// Convert i16 PCM to f32 in `[-1.0, 1.0]`.
fn i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples
        .iter()
        .map(|s| *s as f32 / i16::MAX as f32)
        .collect()
}

/// Run the ASR pipeline: fan out audio to each active ASR config.
///
/// Each config gets its own dedicated OS thread (backends are sync + hold
/// model state). A tokio task per config forwards broadcast frames into a
/// blocking channel feeding that thread. Transcript events are bridged back
/// onto the returned tokio mpsc. `realtime` is true for live capture and
/// false for file analysis (frames arrive faster than real time).
pub fn run_asr_pipeline(
    configs: &[AsrConfig],
    audio_tx: &broadcast::Sender<AudioFrame>,
    sample_rate: u32,
    realtime: bool,
) -> mpsc::Receiver<AsrServerEvent> {
    let (result_tx, result_rx) = mpsc::channel::<AsrServerEvent>(256);

    for config in configs {
        if !matches!(config.backend.as_str(), "sherpa-onnx" | "r2t2") {
            tracing::warn!(
                config_id = %config.id,
                backend = %config.backend,
                "unknown ASR backend, skipping"
            );
            continue;
        }

        let config = config.clone();
        let result_tx_for_thread = result_tx.clone();

        // Bridge tokio broadcast → std mpsc, so the worker thread can block
        // on `recv()` without entering an async context.
        let (audio_in_tx, audio_in_rx) = std::sync::mpsc::sync_channel::<AudioFrame>(256);

        let mut audio_rx = audio_tx.subscribe();
        let audio_in_tx_clone = audio_in_tx.clone();
        tokio::spawn(async move {
            while let Ok(frame) = audio_rx.recv().await {
                if audio_in_tx_clone.send(frame).is_err() {
                    break;
                }
            }
            drop(audio_in_tx_clone);
        });
        // Drop our copy so the worker exits when the broadcast closes.
        drop(audio_in_tx);

        std::thread::Builder::new()
            .name(format!("asr-{}", config.id))
            .spawn(move || {
                let config_id = config.id.clone();
                tracing::info!(
                    config_id = %config_id,
                    label = %config.label,
                    backend = %config.backend,
                    params = ?config.params,
                    "loading ASR model (may download on first run)"
                );

                let (mut backend, asr_rx) = match build_backend(&config, realtime) {
                    Ok(pair) => pair,
                    Err(e) => {
                        let _ = result_tx_for_thread.blocking_send(AsrServerEvent::Warning {
                            config_id: config_id.clone(),
                            message: format!("failed to init ASR: {e}"),
                        });
                        return;
                    }
                };

                tracing::info!(config_id = %config_id, "ASR model loaded");
                let _ = result_tx_for_thread.blocking_send(AsrServerEvent::Ready {
                    config_id: config_id.clone(),
                });

                let mut stats_sent: Option<(Instant, u64)> = None;
                while let Ok(frame) = audio_in_rx.recv() {
                    let f32_samples = i16_to_f32(&frame.samples);
                    let resampled = resample_linear_f32(&f32_samples, sample_rate, ASR_RATE);
                    let asr_frame = AsrAudioFrame::new(resampled.as_slice(), ASR_RATE);

                    if let Err(e) = backend.asr().push_audio(&asr_frame, Channel::Local) {
                        tracing::warn!(config_id = %config_id, "push_audio error: {e}");
                    }
                    drain_events(&asr_rx, &config_id, &result_tx_for_thread);
                    send_stats(
                        &backend,
                        &config_id,
                        &result_tx_for_thread,
                        &mut stats_sent,
                        false,
                    );
                }

                // Audio stream closed — flush remaining transcript.
                if let Err(e) = backend.asr().finish() {
                    tracing::warn!(config_id = %config_id, "finish error: {e}");
                }
                drain_events(&asr_rx, &config_id, &result_tx_for_thread);
                send_stats(
                    &backend,
                    &config_id,
                    &result_tx_for_thread,
                    &mut stats_sent,
                    true,
                );
            })
            .expect("spawn asr worker thread");
    }

    drop(result_tx);
    result_rx
}

/// Forward the backend's decode stats when it has any, at most every
/// [`STATS_INTERVAL`] and only when a new step ran (or when `force`d).
fn send_stats(
    backend: &Backend,
    config_id: &str,
    result_tx: &mpsc::Sender<AsrServerEvent>,
    last: &mut Option<(Instant, u64)>,
    force: bool,
) {
    let Some(stats) = backend.stats() else {
        return;
    };
    let due = match last {
        None => stats.decode_steps > 0,
        Some((at, steps)) => {
            stats.decode_steps != *steps && (force || at.elapsed() >= STATS_INTERVAL)
        }
    };
    if !due && !(force && stats.decode_steps > 0) {
        return;
    }
    *last = Some((Instant::now(), stats.decode_steps));
    let _ = result_tx.blocking_send(AsrServerEvent::Stats {
        config_id: config_id.to_string(),
        stats: stats.into(),
    });
}

/// Drain any pending transcript events from the synchronous receiver and
/// forward them on the tokio mpsc. Non-blocking — uses `try_iter`.
fn drain_events(
    asr_rx: &std::sync::mpsc::Receiver<TranscriptEvent>,
    config_id: &str,
    result_tx: &mpsc::Sender<AsrServerEvent>,
) {
    for evt in asr_rx.try_iter() {
        let mapped = match evt {
            TranscriptEvent::SpeechStarted { ts_ms, .. } => AsrServerEvent::SpeechStarted {
                config_id: config_id.to_string(),
                ts_ms: ts_ms as f64,
            },
            TranscriptEvent::SpeechEnded { ts_ms, .. } => AsrServerEvent::SpeechEnded {
                config_id: config_id.to_string(),
                ts_ms: ts_ms as f64,
            },
            TranscriptEvent::Partial { ts_ms, text, .. } => AsrServerEvent::Partial {
                config_id: config_id.to_string(),
                ts_ms: ts_ms as f64,
                text,
            },
            TranscriptEvent::Final {
                ts_ms,
                end_ms,
                text,
                confidence,
                ..
            } => AsrServerEvent::Final {
                config_id: config_id.to_string(),
                ts_ms: ts_ms as f64,
                end_ms: end_ms as f64,
                text,
                confidence,
            },
            TranscriptEvent::Warning(message) => AsrServerEvent::Warning {
                config_id: config_id.to_string(),
                message,
            },
        };
        if result_tx.blocking_send(mapped).is_err() {
            // Receiver dropped — nothing more to do.
            return;
        }
    }
}

/// Available ASR backends and their configurable parameters.
pub fn available_asr_backends() -> HashMap<String, Vec<crate::pipeline::ParamInfo>> {
    use crate::pipeline::{ParamInfo, ParamType, SelectOption};

    let mut backends = HashMap::new();
    backends.insert(
        "sherpa-onnx".to_string(),
        vec![ParamInfo {
            name: "preset".to_string(),
            description: "Model preset".to_string(),
            param_type: ParamType::Select(vec![
                SelectOption {
                    value: "bilingual".into(),
                    label: "Bilingual ZH+EN (default)".into(),
                },
                SelectOption {
                    value: "en".into(),
                    label: "English (Zipformer)".into(),
                },
                SelectOption {
                    value: "zh".into(),
                    label: "Chinese (Paraformer)".into(),
                },
                SelectOption {
                    value: "paraformer-zh-en".into(),
                    label: "Bilingual ZH+EN (Paraformer)".into(),
                },
            ]),
            default: serde_json::json!("bilingual"),
        }],
    );
    let select = |options: &[(&str, &str)]| {
        ParamType::Select(
            options
                .iter()
                .map(|(value, label)| SelectOption {
                    value: (*value).into(),
                    label: (*label).into(),
                })
                .collect(),
        )
    };
    backends.insert(
        "r2t2".to_string(),
        vec![
            ParamInfo {
                name: "weights".to_string(),
                description: "Weights (Confucius4-R2T2 GGUF)".to_string(),
                param_type: select(&[
                    ("q8", "Q8_0 — 2.5 GB (default)"),
                    ("q4", "Q4_K_M — 1.7 GB"),
                    ("f16", "F16 — 4.1 GB"),
                ]),
                default: serde_json::json!("q8"),
            },
            ParamInfo {
                name: "chunk_ms".to_string(),
                description: "Decode chunk".to_string(),
                param_type: select(&[
                    ("80", "80 ms"),
                    ("160", "160 ms (reference)"),
                    ("320", "320 ms"),
                    ("480", "480 ms"),
                    ("640", "640 ms"),
                    ("1000", "1 s"),
                ]),
                default: serde_json::json!("160"),
            },
            ParamInfo {
                name: "language".to_string(),
                description: "Language".to_string(),
                param_type: select(&[
                    ("auto", "Auto-detect"),
                    ("Chinese", "Chinese"),
                    ("English", "English"),
                ]),
                default: serde_json::json!("auto"),
            },
        ],
    );
    backends
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r2t2_params_map_to_config() {
        let params: HashMap<String, serde_json::Value> = [
            ("weights", "q4"),
            ("chunk_ms", "320"),
            ("language", "English"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), serde_json::json!(v)))
        .collect();
        let cfg = r2t2_config(&params, true);
        assert_eq!(cfg.weights, R2T2_Q4_K_M);
        assert_eq!(cfg.chunk_ms, 320);
        assert_eq!(cfg.language.as_deref(), Some("English"));
        assert!(cfg.catch_up);

        let cfg = r2t2_config(&HashMap::new(), false);
        assert_eq!(cfg.weights, R2T2_Q8_0);
        assert_eq!(cfg.chunk_ms, 160);
        assert_eq!(cfg.language, None);
        assert!(!cfg.catch_up);
    }

    #[test]
    fn every_backend_param_default_is_one_of_its_options() {
        for (backend, params) in available_asr_backends() {
            for p in params {
                if let crate::pipeline::ParamType::Select(opts) = &p.param_type {
                    let default = p.default.as_str().unwrap();
                    assert!(
                        opts.iter().any(|o| o.value == default),
                        "{backend}.{} default `{default}` not in options",
                        p.name
                    );
                }
            }
        }
    }

    #[test]
    fn cache_status_lists_r2t2_weights() {
        let status = cache_status_all();
        for name in R2T2_WEIGHT_NAMES {
            assert!(status.contains_key(&format!("{R2T2_KEY_PREFIX}{name}")));
        }
    }
}
