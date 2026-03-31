use crate::audio_source::AudioFrame;
use crate::session::VadConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;
use tokio::sync::{broadcast, mpsc};
use wavekat_turn::audio::PipecatSmartTurn;
use wavekat_turn::{AudioFrame as TurnAudioFrame, AudioTurnDetector, TurnController, TurnState};
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
    vad_broadcast: Option<&broadcast::Sender<VadProbability>>,
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
        let vad_broadcast = vad_broadcast.cloned();

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
                            if let Some(ref vad_broadcast) = vad_broadcast {
                                let _ = vad_broadcast.send(VadProbability {
                                    config_id: config_id.clone(),
                                    timestamp_ms: frame.timestamp_ms,
                                    probability,
                                });
                            }
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

/// Configuration for a single turn detection instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnConfig {
    /// Unique identifier for this config.
    pub id: String,
    /// Human-readable label.
    pub label: String,
    /// Backend name: currently only "pipecat".
    pub backend: String,
    /// Backend-specific parameters.
    pub params: HashMap<String, serde_json::Value>,
}

/// Configuration for a VAD-gated turn detection pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineConfig {
    /// Unique identifier for this config.
    pub id: String,
    /// Human-readable label.
    pub label: String,
    /// References an existing VadConfig by id.
    pub vad_config_id: String,
    /// References an existing TurnConfig by id.
    pub turn_config_id: String,
    /// VAD probability below this = speech ended.
    pub speech_end_threshold: f32,
    /// VAD probability above this = speech started.
    pub speech_start_threshold: f32,
    /// Silence must hold for this long before firing (ms).
    pub min_silence_ms: u32,
    /// Reset mode on speech start: "hard" always resets the turn detector,
    /// "soft" uses `reset_if_finished` to preserve audio across mid-sentence pauses.
    #[serde(default = "default_reset_mode")]
    pub reset_mode: String,
}

fn default_reset_mode() -> String {
    "hard".to_string()
}

/// Lightweight VAD probability event for broadcasting to pipeline mode runners.
#[derive(Debug, Clone)]
pub struct VadProbability {
    pub config_id: String,
    pub timestamp_ms: f64,
    pub probability: f32,
}

/// A pipeline mode event.
#[derive(Debug, Clone)]
pub enum PipelineModeEvent {
    SpeechStart,
    SpeechEnd {
        turn_state: String,
        turn_confidence: f32,
        turn_latency_ms: u64,
        audio_duration_ms: u64,
    },
}

/// A pipeline mode result.
#[derive(Debug, Clone)]
pub struct PipelineModeResult {
    pub config_id: String,
    pub timestamp_ms: f64,
    pub event: PipelineModeEvent,
}

/// A turn detection result.
#[derive(Debug, Clone, Serialize)]
pub struct TurnResult {
    /// Config ID that produced this result.
    pub config_id: String,
    /// Timestamp in milliseconds of the last audio frame included in this prediction.
    pub timestamp_ms: f64,
    /// Predicted state: "finished", "unfinished", or "wait".
    pub state: String,
    /// Confidence score in [0.0, 1.0].
    pub confidence: f32,
    /// Model inference latency in milliseconds.
    pub latency_ms: u64,
    /// Per-stage timing breakdown in pipeline order.
    pub stage_times: Vec<StageTiming>,
}

/// Run the turn detection pipeline for multiple configs concurrently.
///
/// Each config gets its own async task. All results flow into the returned
/// receiver, tagged with `config_id`. Mirrors `run_pipeline` for VAD.
pub fn run_turn_pipeline(
    configs: &[TurnConfig],
    audio_tx: &broadcast::Sender<AudioFrame>,
    sample_rate: u32,
) -> mpsc::Receiver<TurnResult> {
    let (result_tx, result_rx) = mpsc::channel::<TurnResult>(256);

    for config in configs {
        let mut detector = match create_turn_detector(config) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(config_id = %config.id, "failed to create turn detector: {e}");
                continue;
            }
        };

        // predict_interval_ms is stored as a string (SelectOption value)
        let interval_ms = config
            .params
            .get("predict_interval_ms")
            .and_then(|v| v.as_str().and_then(|s| s.parse::<u64>().ok()))
            .unwrap_or(500);
        // Each audio frame is 10 ms
        let predict_every_frames = (interval_ms / 10).max(1) as u32;

        let config_id = config.id.clone();
        let mut audio_rx = audio_tx.subscribe();
        let result_tx = result_tx.clone();

        tokio::spawn(async move {
            let mut frames_since_predict: u32 = 0;

            while let Ok(frame) = audio_rx.recv().await {
                // Pipecat requires 16 kHz audio
                let samples = if sample_rate != 16000 {
                    resample_linear(&frame.samples, sample_rate, 16000)
                } else {
                    frame.samples.clone()
                };

                let turn_frame = TurnAudioFrame::new(samples.as_slice(), 16000);
                detector.push_audio(&turn_frame);
                frames_since_predict += 1;

                if frames_since_predict >= predict_every_frames {
                    frames_since_predict = 0;
                    match detector.predict() {
                        Ok(prediction) => {
                            let state = match prediction.state {
                                TurnState::Finished => "finished",
                                TurnState::Unfinished => "unfinished",
                                TurnState::Wait => "wait",
                            };
                            let result = TurnResult {
                                config_id: config_id.clone(),
                                timestamp_ms: frame.timestamp_ms,
                                state: state.to_string(),
                                confidence: prediction.confidence,
                                latency_ms: prediction.latency_ms,
                                stage_times: prediction
                                    .stage_times
                                    .iter()
                                    .map(|s| StageTiming {
                                        name: s.name.to_string(),
                                        us: s.us,
                                    })
                                    .collect(),
                            };
                            if result_tx.send(result).await.is_err() {
                                return;
                            }
                        }
                        Err(e) => {
                            tracing::warn!(config_id = %config_id, "turn prediction error: {e}");
                        }
                    }
                }
            }
        });
    }

    // Drop original sender so result_rx completes when all tasks finish
    drop(result_tx);

    result_rx
}

/// Create a turn detector from a config.
fn create_turn_detector(config: &TurnConfig) -> Result<Box<dyn AudioTurnDetector>, String> {
    match config.backend.as_str() {
        "pipecat" => {
            let detector = PipecatSmartTurn::new()
                .map_err(|e| format!("failed to create PipecatSmartTurn: {e}"))?;
            Ok(Box::new(detector))
        }
        other => Err(format!("unknown turn backend: {other}")),
    }
}

/// Create a TurnController-wrapped detector from a config.
fn create_turn_controller(
    config: &TurnConfig,
) -> Result<TurnController<PipecatSmartTurn>, String> {
    match config.backend.as_str() {
        "pipecat" => {
            let detector = PipecatSmartTurn::new()
                .map_err(|e| format!("failed to create PipecatSmartTurn: {e}"))?;
            Ok(TurnController::new(detector))
        }
        other => Err(format!("unknown turn backend: {other}")),
    }
}

/// Run the pipeline mode: VAD-gated turn detection.
///
/// For each `PipelineConfig`, spawns a task that subscribes to both the audio
/// broadcast and the VAD probability broadcast. When VAD probability crosses
/// the speech start threshold, audio frames are fed to a fresh turn detector.
/// When silence holds for `min_silence_ms`, a turn prediction is made.
pub fn run_pipeline_mode(
    pipeline_configs: &[PipelineConfig],
    turn_configs: &[TurnConfig],
    audio_tx: &broadcast::Sender<AudioFrame>,
    vad_broadcast: &broadcast::Sender<VadProbability>,
    sample_rate: u32,
) -> mpsc::Receiver<PipelineModeResult> {
    let (result_tx, result_rx) = mpsc::channel::<PipelineModeResult>(256);

    for pipeline_config in pipeline_configs {
        // Find the referenced turn config
        let turn_config = match turn_configs
            .iter()
            .find(|c| c.id == pipeline_config.turn_config_id)
        {
            Some(c) => c.clone(),
            None => {
                tracing::warn!(
                    pipeline_id = %pipeline_config.id,
                    turn_config_id = %pipeline_config.turn_config_id,
                    "pipeline references nonexistent turn config, skipping"
                );
                continue;
            }
        };

        // Create a TurnController-wrapped detector for pipeline mode
        let mut ctrl = match create_turn_controller(&turn_config) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(
                    pipeline_id = %pipeline_config.id,
                    "failed to create turn controller for pipeline: {e}"
                );
                continue;
            }
        };

        let config = pipeline_config.clone();
        let use_soft_reset = config.reset_mode == "soft";
        let mut audio_rx = audio_tx.subscribe();
        let mut vad_rx = vad_broadcast.subscribe();
        let result_tx = result_tx.clone();

        tokio::spawn(async move {
            let mut speech_started = false;
            let mut silence_start_ms: Option<f64> = None;
            // Buffer audio frames so we can drain them deterministically
            // when the corresponding VAD probability arrives.
            let mut audio_buffer: Vec<AudioFrame> = Vec::new();

            loop {
                tokio::select! {
                    Ok(frame) = audio_rx.recv() => {
                        audio_buffer.push(frame);
                    }
                    Ok(vad) = vad_rx.recv() => {
                        if vad.config_id != config.vad_config_id {
                            continue;
                        }

                        // Drain all buffered audio frames up to (and including)
                        // this VAD timestamp before making speech decisions.
                        // This guarantees the turn detector always receives the
                        // same audio regardless of tokio scheduling order.
                        let drain_end = audio_buffer
                            .partition_point(|f| f.timestamp_ms <= vad.timestamp_ms);
                        let frames_to_process: Vec<_> =
                            audio_buffer.drain(..drain_end).collect();

                        for frame in &frames_to_process {
                            if speech_started {
                                let samples = if sample_rate != 16000 {
                                    resample_linear(&frame.samples, sample_rate, 16000)
                                } else {
                                    frame.samples.clone()
                                };
                                let turn_frame = TurnAudioFrame::new(&samples, 16000);
                                ctrl.push_audio(&turn_frame);
                            }
                        }

                        if !speech_started && vad.probability > config.speech_start_threshold {
                            // Speech start — reset detector based on configured mode.
                            // Soft mode preserves audio across mid-sentence pauses.
                            if use_soft_reset {
                                ctrl.reset_if_finished();
                            } else {
                                ctrl.reset();
                            }
                            speech_started = true;
                            silence_start_ms = None;

                            let result = PipelineModeResult {
                                config_id: config.id.clone(),
                                timestamp_ms: vad.timestamp_ms,
                                event: PipelineModeEvent::SpeechStart,
                            };
                            if result_tx.send(result).await.is_err() {
                                return;
                            }
                        } else if speech_started && vad.probability < config.speech_end_threshold {
                            // Below end threshold — track silence duration
                            if silence_start_ms.is_none() {
                                silence_start_ms = Some(vad.timestamp_ms);
                            }

                            if let Some(start) = silence_start_ms {
                                if vad.timestamp_ms - start >= config.min_silence_ms as f64 {
                                    // Silence held long enough — predict and emit speech end
                                    let (state, confidence, latency, audio_dur) = match ctrl.predict() {
                                        Ok(pred) => {
                                            let state = match pred.state {
                                                TurnState::Finished => "finished",
                                                TurnState::Unfinished => "unfinished",
                                                TurnState::Wait => "wait",
                                            };
                                            (state.to_string(), pred.confidence, pred.latency_ms, pred.audio_duration_ms)
                                        }
                                        Err(e) => {
                                            tracing::warn!(
                                                pipeline_id = %config.id,
                                                "turn prediction error: {e}"
                                            );
                                            ("error".to_string(), 0.0, 0, 0)
                                        }
                                    };

                                    let result = PipelineModeResult {
                                        config_id: config.id.clone(),
                                        timestamp_ms: vad.timestamp_ms,
                                        event: PipelineModeEvent::SpeechEnd {
                                            turn_state: state,
                                            turn_confidence: confidence,
                                            turn_latency_ms: latency,
                                            audio_duration_ms: audio_dur,
                                        },
                                    };
                                    if result_tx.send(result).await.is_err() {
                                        return;
                                    }

                                    speech_started = false;
                                    silence_start_ms = None;
                                }
                            }
                        } else if speech_started {
                            // Probability went back above end threshold — reset silence
                            silence_start_ms = None;
                        }
                    }
                    else => break,
                }
            }
        });
    }

    drop(result_tx);
    result_rx
}

/// Return the list of available turn detection backends and their parameters.
pub fn available_turn_backends() -> HashMap<String, Vec<ParamInfo>> {
    let mut backends = HashMap::new();

    backends.insert(
        "pipecat".to_string(),
        vec![ParamInfo {
            name: "predict_interval_ms".to_string(),
            description: "Prediction interval".to_string(),
            param_type: ParamType::Select(vec![
                SelectOption {
                    value: "200".into(),
                    label: "200 ms".into(),
                },
                SelectOption {
                    value: "500".into(),
                    label: "500 ms".into(),
                },
                SelectOption {
                    value: "1000".into(),
                    label: "1000 ms".into(),
                },
                SelectOption {
                    value: "2000".into(),
                    label: "2000 ms".into(),
                },
            ]),
            default: serde_json::json!("500"),
        }],
    );

    backends
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
