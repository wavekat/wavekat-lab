use crate::audio_source::AudioFrame;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::{broadcast, mpsc};
use wavekat_asr::backends::sherpa_onnx::{
    ModelPreset, SherpaOnnxAsr, BILINGUAL_ZH_EN, PARAFORMER_BILINGUAL_ZH_EN, PARAFORMER_ZH,
    ZIPFORMER_EN,
};
use wavekat_asr::{AudioFrame as AsrAudioFrame, Channel, StreamingAsr, TranscriptEvent};

/// ASR target sample rate. Sherpa-onnx wants 16 kHz f32.
const ASR_RATE: u32 = 16_000;

/// Configuration for a single ASR instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrConfig {
    /// Unique identifier for this config.
    pub id: String,
    /// Human-readable label.
    pub label: String,
    /// Backend name: currently only "sherpa-onnx".
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
/// Each config gets its own dedicated OS thread (sherpa-onnx is sync + holds
/// model state). A tokio task per config forwards broadcast frames into a
/// blocking channel feeding that thread. Transcript events are bridged back
/// onto the returned tokio mpsc.
pub fn run_asr_pipeline(
    configs: &[AsrConfig],
    audio_tx: &broadcast::Sender<AudioFrame>,
    sample_rate: u32,
) -> mpsc::Receiver<AsrServerEvent> {
    let (result_tx, result_rx) = mpsc::channel::<AsrServerEvent>(256);

    for config in configs {
        if config.backend != "sherpa-onnx" {
            tracing::warn!(
                config_id = %config.id,
                backend = %config.backend,
                "unknown ASR backend, skipping"
            );
            continue;
        }

        let preset_name = config
            .params
            .get("preset")
            .and_then(|v| v.as_str())
            .unwrap_or("bilingual")
            .to_string();
        let preset = pick_preset(&preset_name);

        let config_id = config.id.clone();
        let label = config.label.clone();
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

        let config_id_for_thread = config_id.clone();
        std::thread::Builder::new()
            .name(format!("asr-{}", config.id))
            .spawn(move || {
                tracing::info!(
                    config_id = %config_id_for_thread,
                    label = %label,
                    preset = %preset_name,
                    "loading sherpa-onnx model (may download on first run)"
                );

                let (mut asr, asr_rx) = match SherpaOnnxAsr::with_preset(preset) {
                    Ok(pair) => pair,
                    Err(e) => {
                        let _ = result_tx_for_thread.blocking_send(AsrServerEvent::Warning {
                            config_id: config_id_for_thread.clone(),
                            message: format!("failed to init ASR: {e}"),
                        });
                        return;
                    }
                };

                tracing::info!(config_id = %config_id_for_thread, "ASR model loaded");
                let _ = result_tx_for_thread.blocking_send(AsrServerEvent::Ready {
                    config_id: config_id_for_thread.clone(),
                });

                while let Ok(frame) = audio_in_rx.recv() {
                    let f32_samples = i16_to_f32(&frame.samples);
                    let resampled = resample_linear_f32(&f32_samples, sample_rate, ASR_RATE);
                    let asr_frame = AsrAudioFrame::new(resampled.as_slice(), ASR_RATE);

                    if let Err(e) = asr.push_audio(&asr_frame, Channel::Local) {
                        tracing::warn!(
                            config_id = %config_id_for_thread,
                            "push_audio error: {e}"
                        );
                    }
                    drain_events(&asr_rx, &config_id_for_thread, &result_tx_for_thread);
                }

                // Audio stream closed — flush remaining transcript.
                if let Err(e) = asr.finish() {
                    tracing::warn!(
                        config_id = %config_id_for_thread,
                        "finish error: {e}"
                    );
                }
                drain_events(&asr_rx, &config_id_for_thread, &result_tx_for_thread);
            })
            .expect("spawn asr worker thread");
    }

    drop(result_tx);
    result_rx
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
    backends
}
