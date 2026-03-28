use crate::audio_source::AudioFrame;
use crate::session::VadConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::time::Instant;
use tokio::sync::{broadcast, mpsc};
use wavekat_vad::preprocessing::Preprocessor;
use wavekat_vad::{FrameAdapter, ProcessTimings, VoiceActivityDetector};

/// Per-stage timing entry (name + microseconds).
#[derive(Debug, Clone, Serialize)]
pub struct StageTiming {
    /// Stage name (e.g. "fbank", "onnx").
    pub name: String,
    /// Time in microseconds for this frame.
    pub us: f64,
}

/// A VAD result from the pipeline.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineResult {
    /// Config ID that produced this result.
    pub config_id: String,
    /// Timestamp in milliseconds.
    pub timestamp_ms: f64,
    /// Speech probability (0.0 - 1.0).
    pub probability: f32,
    /// Inference time in microseconds for this frame.
    pub inference_us: f64,
    /// Per-stage timing breakdown in pipeline order.
    pub stage_times: Vec<StageTiming>,
    /// Frame duration in milliseconds (from backend capabilities).
    pub frame_duration_ms: u32,
    /// Preprocessed audio samples (for visualization).
    #[serde(skip_serializing)]
    pub preprocessed_samples: Vec<i16>,
}

/// Compute per-frame stage timing deltas between two snapshots.
fn stage_deltas(
    before: &ProcessTimings,
    after: &ProcessTimings,
    num_frames: usize,
) -> Vec<StageTiming> {
    if num_frames == 0 {
        return Vec::new();
    }
    after
        .stages
        .iter()
        .map(|(name, dur_after)| {
            let dur_before = before
                .stages
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, d)| *d)
                .unwrap_or(std::time::Duration::ZERO);
            let delta_us = (dur_after.as_secs_f64() - dur_before.as_secs_f64()) * 1_000_000.0;
            StageTiming {
                name: name.to_string(),
                us: delta_us / num_frames as f64,
            }
        })
        .collect()
}

/// Run the VAD pipeline: fan out audio frames to multiple VAD configs.
///
/// Each config gets its own task with its own broadcast receiver, so all
/// backends process frames concurrently. Each backend is wrapped in a
/// FrameAdapter that buffers samples until the backend's required frame
/// size is reached.
///
/// Returns an mpsc receiver that yields results from all configs.
pub fn run_pipeline(
    configs: &[VadConfig],
    audio_tx: &broadcast::Sender<AudioFrame>,
    sample_rate: u32,
) -> mpsc::Receiver<PipelineResult> {
    let (result_tx, result_rx) = mpsc::channel::<PipelineResult>(1024);

    for config in configs {
        // Determine the rate the backend actually needs
        let effective_rate =
            backend_required_rate(&config.backend, sample_rate).unwrap_or(sample_rate);

        let detector = match create_detector(config, effective_rate) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(config_id = %config.id, "failed to create detector: {e}");
                continue;
            }
        };

        let mut preprocessor = Preprocessor::new(&config.preprocessing, effective_rate);
        let mut adapter = FrameAdapter::new(detector);

        if effective_rate != sample_rate {
            tracing::info!(
                config_id = %config.id,
                backend = %config.backend,
                from = sample_rate,
                to = effective_rate,
                "will resample audio for this backend"
            );
        }
        tracing::info!(
            config_id = %config.id,
            backend = %config.backend,
            frame_size = adapter.frame_size(),
            "created VAD detector"
        );

        let config_id = config.id.clone();
        let frame_duration_ms = adapter.capabilities().frame_duration_ms;
        let mut audio_rx = audio_tx.subscribe();
        let result_tx = result_tx.clone();

        tokio::spawn(async move {
            while let Ok(frame) = audio_rx.recv().await {
                // Resample if the backend requires a different rate
                let samples = if effective_rate != sample_rate {
                    resample_linear(&frame.samples, sample_rate, effective_rate)
                } else {
                    frame.samples.clone()
                };

                // Apply preprocessing
                let preprocessed_samples = preprocessor.process(&samples);

                // Run VAD on preprocessed audio (adapter handles frame buffering)
                let timings_before = adapter.timings();
                let start = Instant::now();
                match adapter.process_all(&preprocessed_samples, effective_rate) {
                    Ok(probabilities) => {
                        let elapsed_us = start.elapsed().as_secs_f64() * 1_000_000.0;
                        // Distribute total time evenly across produced frames
                        let per_frame_us = if probabilities.is_empty() {
                            0.0
                        } else {
                            elapsed_us / probabilities.len() as f64
                        };
                        let per_frame_stages =
                            stage_deltas(&timings_before, &adapter.timings(), probabilities.len());
                        for probability in probabilities {
                            let result = PipelineResult {
                                config_id: config_id.clone(),
                                timestamp_ms: frame.timestamp_ms,
                                probability,
                                inference_us: per_frame_us,
                                stage_times: per_frame_stages.clone(),
                                frame_duration_ms,
                                preprocessed_samples: preprocessed_samples.clone(),
                            };
                            if result_tx.send(result).await.is_err() {
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            config_id = %config_id,
                            "VAD processing error: {e}"
                        );
                    }
                }
            }
        });
    }

    // Drop the original sender so result_rx completes when all tasks finish
    drop(result_tx);

    result_rx
}

/// Return the sample rate that a backend requires.
///
/// Returns `None` when the backend accepts the given `input_rate` as-is.
fn backend_required_rate(backend: &str, input_rate: u32) -> Option<u32> {
    match backend {
        // TEN-VAD and FireRedVAD only support 16 kHz
        "ten-vad" | "firered-vad" if input_rate != 16000 => Some(16000),
        _ => None,
    }
}

/// Resample audio via linear interpolation.
///
/// Good enough for VAD — we only need the sample rate to be correct, not
/// audiophile-quality resampling.
fn resample_linear(samples: &[i16], from_rate: u32, to_rate: u32) -> Vec<i16> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let output_len = (samples.len() as f64 * ratio).round() as usize;
    let mut output = Vec::with_capacity(output_len);
    for i in 0..output_len {
        let src_pos = i as f64 / ratio;
        let src_idx = src_pos as usize;
        let frac = src_pos - src_idx as f64;
        let s0 = samples[src_idx.min(samples.len() - 1)] as f64;
        let s1 = samples[(src_idx + 1).min(samples.len() - 1)] as f64;
        output.push((s0 + frac * (s1 - s0)) as i16);
    }
    output
}

/// Create a VAD detector from a config.
fn create_detector(
    config: &VadConfig,
    sample_rate: u32,
) -> Result<Box<dyn VoiceActivityDetector>, String> {
    match config.backend.as_str() {
        "webrtc-vad" => {
            use wavekat_vad::backends::webrtc::{WebRtcVad, WebRtcVadMode};

            let mode_str = config
                .params
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("quality");

            let mode = match mode_str {
                "quality" => WebRtcVadMode::Quality,
                "low_bitrate" => WebRtcVadMode::LowBitrate,
                "aggressive" => WebRtcVadMode::Aggressive,
                "very_aggressive" => WebRtcVadMode::VeryAggressive,
                other => return Err(format!("unknown webrtc mode: {other}")),
            };

            let vad = WebRtcVad::new(sample_rate, mode)
                .map_err(|e| format!("failed to create WebRTC VAD: {e}"))?;
            Ok(Box::new(vad))
        }
        "silero-vad" => {
            use wavekat_vad::backends::silero::SileroVad;

            let vad = SileroVad::new(sample_rate)
                .map_err(|e| format!("failed to create Silero VAD: {e}"))?;
            Ok(Box::new(vad))
        }
        "ten-vad" => {
            use wavekat_vad::backends::ten_vad::TenVad;

            let vad = TenVad::new().map_err(|e| format!("failed to create TEN VAD: {e}"))?;
            Ok(Box::new(vad))
        }
        "firered-vad" => {
            use wavekat_vad::backends::firered::FireRedVad;

            let vad = FireRedVad::new().map_err(|e| format!("failed to create FireRedVAD: {e}"))?;
            Ok(Box::new(vad))
        }
        other => Err(format!("unknown backend: {other}")),
    }
}

/// Return the list of available backends and their configurable parameters.
pub fn available_backends() -> HashMap<String, Vec<ParamInfo>> {
    let mut backends = HashMap::new();

    backends.insert(
        "webrtc-vad".to_string(),
        vec![ParamInfo {
            name: "mode".to_string(),
            description: "Aggressiveness mode".to_string(),
            param_type: ParamType::Select(vec![
                SelectOption {
                    value: "quality".into(),
                    label: "0 - Quality".into(),
                },
                SelectOption {
                    value: "low_bitrate".into(),
                    label: "1 - Low Bitrate".into(),
                },
                SelectOption {
                    value: "aggressive".into(),
                    label: "2 - Aggressive".into(),
                },
                SelectOption {
                    value: "very_aggressive".into(),
                    label: "3 - Very Aggressive".into(),
                },
            ]),
            default: serde_json::json!("quality"),
        }],
    );

    let threshold_param = ParamInfo {
        name: "threshold".to_string(),
        description: "Speech threshold".to_string(),
        param_type: ParamType::Float { min: 0.0, max: 1.0 },
        default: serde_json::json!(0.5),
    };

    backends.insert("silero-vad".to_string(), vec![threshold_param.clone()]);

    backends.insert("ten-vad".to_string(), vec![threshold_param.clone()]);

    backends.insert("firered-vad".to_string(), vec![threshold_param]);

    backends
}

/// Return the list of available preprocessing parameters.
pub fn preprocessing_params() -> Vec<ParamInfo> {
    vec![
        ParamInfo {
            name: "high_pass_hz".to_string(),
            description: "High-pass filter cutoff (Hz)".to_string(),
            param_type: ParamType::Float {
                min: 20.0,
                max: 500.0,
            },
            default: serde_json::json!(null),
        },
        ParamInfo {
            name: "denoise".to_string(),
            description: "RNNoise noise suppression".to_string(),
            param_type: ParamType::Select(vec![
                SelectOption {
                    value: "off".into(),
                    label: "Off".into(),
                },
                SelectOption {
                    value: "on".into(),
                    label: "On".into(),
                },
            ]),
            default: serde_json::json!("off"),
        },
        ParamInfo {
            name: "normalize_dbfs".to_string(),
            description: "Normalize to target level (dBFS)".to_string(),
            param_type: ParamType::Float {
                min: -40.0,
                max: 0.0,
            },
            default: serde_json::json!(null),
        },
    ]
}

/// Description of a configurable parameter.
#[derive(Debug, Clone, Serialize)]
pub struct ParamInfo {
    /// Parameter name.
    pub name: String,
    /// Human-readable description.
    pub description: String,
    /// Parameter type and constraints.
    pub param_type: ParamType,
    /// Default value.
    pub default: serde_json::Value,
}

/// A select option with a machine value and a human-readable label.
#[derive(Debug, Clone, Serialize)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
}

/// Type of a configurable parameter.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "options")]
pub enum ParamType {
    /// Select from a list of options.
    Select(Vec<SelectOption>),
    /// Float value with min/max range.
    #[allow(dead_code)]
    Float { min: f64, max: f64 },
    /// Integer value with min/max range.
    #[allow(dead_code)]
    Int { min: i64, max: i64 },
}
