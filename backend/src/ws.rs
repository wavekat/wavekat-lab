use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::audio_source::{self, AudioDevice, AudioFrame, ChannelSelect};
use crate::pipeline;
use crate::session::VadConfig;
use crate::spectrum::{SpectrumAnalyzer, DEFAULT_OUTPUT_BINS};

/// Default maximum recording duration: 2 minutes.
fn default_max_duration_secs() -> u64 {
    120
}

/// Messages sent from the client to the server.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    ListDevices,
    ListBackends,
    StartRecording {
        device_index: usize,
        /// Maximum recording duration in seconds. Defaults to 120 (2 minutes).
        #[serde(default = "default_max_duration_secs")]
        max_duration_secs: u64,
    },
    StopRecording,
    LoadFile {
        path: String,
        #[serde(default)]
        channel: ChannelSelect,
    },
    SetConfigs {
        configs: Vec<VadConfig>,
    },
    SetSpectrumBins {
        bins: usize,
    },
    ListTurnBackends,
    /// Set the active turn detection configs (replaces previous list).
    SetTurnConfigs {
        configs: Vec<pipeline::TurnConfig>,
    },
    /// Set the active pipeline mode configs (replaces previous list).
    SetPipelineConfigs {
        configs: Vec<pipeline::PipelineConfig>,
    },
}

/// Messages sent from the server to the client.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Devices {
        devices: Vec<AudioDevice>,
    },
    Backends {
        backends: std::collections::HashMap<String, Vec<pipeline::ParamInfo>>,
        /// Preprocessing parameters available for all configs.
        preprocessing_params: Vec<pipeline::ParamInfo>,
    },
    RecordingStarted {
        sample_rate: u32,
        /// Number of frequency bins in spectrum data.
        spectrum_bins: usize,
    },
    Audio {
        timestamp_ms: f64,
        samples: Vec<i16>,
    },
    /// Frequency spectrum data computed via FFT.
    Spectrum {
        timestamp_ms: f64,
        /// Magnitude values in dB for each frequency bin (0 to Nyquist).
        magnitudes: Vec<f32>,
    },
    /// Preprocessed audio for a specific config.
    PreprocessedAudio {
        config_id: String,
        timestamp_ms: f64,
        samples: Vec<i16>,
    },
    /// Spectrum of preprocessed audio for a specific config.
    PreprocessedSpectrum {
        config_id: String,
        timestamp_ms: f64,
        magnitudes: Vec<f32>,
    },
    Vad {
        config_id: String,
        timestamp_ms: f64,
        probability: f32,
        /// Inference time in microseconds for this frame.
        inference_us: f64,
        /// Per-stage timing breakdown (e.g. fbank, cmvn, onnx).
        stage_times: Vec<pipeline::StageTiming>,
        /// Frame duration in milliseconds (from backend capabilities).
        frame_duration_ms: u32,
    },
    TurnBackends {
        backends: std::collections::HashMap<String, Vec<pipeline::ParamInfo>>,
    },
    /// Turn detection prediction from a specific config.
    Turn {
        config_id: String,
        timestamp_ms: f64,
        /// "finished", "unfinished", or "wait"
        state: String,
        confidence: f32,
        /// Model inference latency in milliseconds.
        latency_ms: u64,
        /// Per-stage timing breakdown (e.g. audio_prep, mel, onnx).
        stage_times: Vec<pipeline::StageTiming>,
    },
    /// Pipeline mode event (speech start/end with turn prediction).
    Pipeline {
        config_id: String,
        timestamp_ms: f64,
        /// "speech_start" or "speech_end"
        event: String,
        turn_state: Option<String>,
        turn_confidence: Option<f32>,
        turn_latency_ms: Option<u64>,
    },
    Done,
    Error {
        message: String,
    },
}

fn send_msg(msg: &ServerMessage) -> Message {
    Message::Text(serde_json::to_string(msg).unwrap().into())
}

/// Handle a WebSocket connection.
pub async fn handle_ws(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut configs: Vec<VadConfig> = Vec::new();
    let mut turn_configs: Vec<pipeline::TurnConfig> = Vec::new();
    let mut pipeline_configs: Vec<pipeline::PipelineConfig> = Vec::new();
    let mut stop_tx: Option<tokio::sync::oneshot::Sender<()>> = None;
    let mut spectrum_bins: usize = DEFAULT_OUTPUT_BINS;

    // Use small frames (10ms); FrameAdapter handles buffering to each backend's requirements
    let frame_duration_ms: u32 = 10;

    while let Some(Ok(msg)) = ws_rx.next().await {
        let Message::Text(text) = msg else {
            continue;
        };

        let client_msg: ClientMessage = match serde_json::from_str(&text) {
            Ok(msg) => msg,
            Err(e) => {
                let _ = ws_tx
                    .send(send_msg(&ServerMessage::Error {
                        message: format!("invalid message: {e}"),
                    }))
                    .await;
                continue;
            }
        };

        match client_msg {
            ClientMessage::ListDevices => {
                let devices = audio_source::list_devices();
                let _ = ws_tx
                    .send(send_msg(&ServerMessage::Devices { devices }))
                    .await;
            }

            ClientMessage::ListBackends => {
                let backends = pipeline::available_backends();
                let preprocessing_params = pipeline::preprocessing_params();
                let _ = ws_tx
                    .send(send_msg(&ServerMessage::Backends {
                        backends,
                        preprocessing_params,
                    }))
                    .await;
            }

            ClientMessage::SetConfigs {
                configs: new_configs,
            } => {
                tracing::info!(count = new_configs.len(), "configs updated");
                configs = new_configs;
            }

            ClientMessage::ListTurnBackends => {
                let backends = pipeline::available_turn_backends();
                let _ = ws_tx
                    .send(send_msg(&ServerMessage::TurnBackends { backends }))
                    .await;
            }

            ClientMessage::SetTurnConfigs {
                configs: new_turn_configs,
            } => {
                tracing::info!(count = new_turn_configs.len(), "turn configs updated");
                turn_configs = new_turn_configs;
            }

            ClientMessage::SetPipelineConfigs {
                configs: new_pipeline_configs,
            } => {
                tracing::info!(
                    count = new_pipeline_configs.len(),
                    "pipeline configs updated"
                );
                pipeline_configs = new_pipeline_configs;
            }

            ClientMessage::SetSpectrumBins { bins: new_bins } => {
                // Validate bins (must be power of 2 and divide 512 evenly)
                let valid_bins = [32, 64, 128, 256, 512];
                if valid_bins.contains(&new_bins) {
                    tracing::info!(bins = new_bins, "spectrum bins updated");
                    spectrum_bins = new_bins;
                } else {
                    let _ = ws_tx
                        .send(send_msg(&ServerMessage::Error {
                            message: format!(
                                "invalid bins: {new_bins}, must be one of {valid_bins:?}"
                            ),
                        }))
                        .await;
                }
            }

            ClientMessage::StartRecording {
                device_index,
                max_duration_secs,
            } => {
                // Stop any existing capture
                if let Some(tx) = stop_tx.take() {
                    let _ = tx.send(());
                }

                match audio_source::start_capture(device_index, frame_duration_ms) {
                    Ok(capture) => {
                        let sample_rate = capture.sample_rate;
                        stop_tx = Some(capture.stop);
                        let audio_tx = capture.tx;

                        tracing::info!(sample_rate, "capture started");

                        // Notify client of sample rate and spectrum info
                        let _ = ws_tx
                            .send(send_msg(&ServerMessage::RecordingStarted {
                                sample_rate,
                                spectrum_bins,
                            }))
                            .await;

                        // Create VAD probability broadcast for pipeline mode
                        let (vad_broadcast_tx, _) =
                            broadcast::channel::<pipeline::VadProbability>(4096);
                        let vad_broadcast = if pipeline_configs.is_empty() {
                            None
                        } else {
                            Some(&vad_broadcast_tx)
                        };

                        // Start the pipeline (each config gets its own task)
                        let mut result_rx =
                            pipeline::run_pipeline(&configs, &audio_tx, sample_rate, vad_broadcast);

                        // Start the turn detection pipeline
                        let mut turn_rx = if !turn_configs.is_empty() {
                            Some(pipeline::run_turn_pipeline(
                                &turn_configs,
                                &audio_tx,
                                sample_rate,
                            ))
                        } else {
                            None
                        };

                        // Start pipeline mode (VAD-gated turn detection)
                        let mut pipeline_mode_rx = if !pipeline_configs.is_empty() {
                            Some(pipeline::run_pipeline_mode(
                                &pipeline_configs,
                                &turn_configs,
                                &audio_tx,
                                &vad_broadcast_tx,
                                sample_rate,
                            ))
                        } else {
                            None
                        };

                        // Collect messages from both audio and pipeline into one channel
                        let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel::<ServerMessage>(512);

                        // Forward audio frames and compute spectrum
                        let msg_tx_audio = msg_tx.clone();
                        let mut audio_rx = capture.rx;
                        let bins = spectrum_bins;
                        tokio::spawn(async move {
                            let mut analyzer = SpectrumAnalyzer::with_bins(bins);
                            while let Ok(frame) = audio_rx.recv().await {
                                // Send audio samples
                                let audio_msg = ServerMessage::Audio {
                                    timestamp_ms: frame.timestamp_ms,
                                    samples: frame.samples.clone(),
                                };
                                if msg_tx_audio.send(audio_msg).await.is_err() {
                                    break;
                                }

                                // Compute and send spectrum
                                let magnitudes = analyzer.compute(&frame.samples);
                                let spectrum_msg = ServerMessage::Spectrum {
                                    timestamp_ms: frame.timestamp_ms,
                                    magnitudes,
                                };
                                if msg_tx_audio.send(spectrum_msg).await.is_err() {
                                    break;
                                }
                            }
                        });

                        // Forward turn detection results
                        if let Some(mut turn_rx) = turn_rx.take() {
                            let msg_tx_turn = msg_tx.clone();
                            tokio::spawn(async move {
                                while let Some(result) = turn_rx.recv().await {
                                    let turn_msg = ServerMessage::Turn {
                                        config_id: result.config_id,
                                        timestamp_ms: result.timestamp_ms,
                                        state: result.state,
                                        confidence: result.confidence,
                                        latency_ms: result.latency_ms,
                                        stage_times: result.stage_times,
                                    };
                                    if msg_tx_turn.send(turn_msg).await.is_err() {
                                        break;
                                    }
                                }
                            });
                        }

                        // Forward pipeline mode results
                        if let Some(mut pipeline_mode_rx) = pipeline_mode_rx.take() {
                            let msg_tx_pipeline = msg_tx.clone();
                            tokio::spawn(async move {
                                while let Some(result) = pipeline_mode_rx.recv().await {
                                    let (event, turn_state, turn_confidence, turn_latency_ms) =
                                        match &result.event {
                                            pipeline::PipelineModeEvent::SpeechStart => {
                                                ("speech_start".to_string(), None, None, None)
                                            }
                                            pipeline::PipelineModeEvent::SpeechEnd {
                                                turn_state,
                                                turn_confidence,
                                                turn_latency_ms,
                                            } => (
                                                "speech_end".to_string(),
                                                Some(turn_state.clone()),
                                                Some(*turn_confidence),
                                                Some(*turn_latency_ms),
                                            ),
                                        };
                                    let msg = ServerMessage::Pipeline {
                                        config_id: result.config_id,
                                        timestamp_ms: result.timestamp_ms,
                                        event,
                                        turn_state,
                                        turn_confidence,
                                        turn_latency_ms,
                                    };
                                    if msg_tx_pipeline.send(msg).await.is_err() {
                                        break;
                                    }
                                }
                            });
                        }

                        // Forward VAD results with preprocessed audio and spectrum
                        let msg_tx_vad = msg_tx;
                        let vad_bins = spectrum_bins;
                        tokio::spawn(async move {
                            // Per-config spectrum analyzers (lazily created)
                            let mut analyzers: std::collections::HashMap<String, SpectrumAnalyzer> =
                                std::collections::HashMap::new();

                            while let Some(result) = result_rx.recv().await {
                                // Send VAD result
                                let vad_msg = ServerMessage::Vad {
                                    config_id: result.config_id.clone(),
                                    timestamp_ms: result.timestamp_ms,
                                    probability: result.probability,
                                    inference_us: result.inference_us,
                                    stage_times: result.stage_times.clone(),
                                    frame_duration_ms: result.frame_duration_ms,
                                };
                                if msg_tx_vad.send(vad_msg).await.is_err() {
                                    break;
                                }

                                // Send preprocessed audio
                                let audio_msg = ServerMessage::PreprocessedAudio {
                                    config_id: result.config_id.clone(),
                                    timestamp_ms: result.timestamp_ms,
                                    samples: result.preprocessed_samples.clone(),
                                };
                                if msg_tx_vad.send(audio_msg).await.is_err() {
                                    break;
                                }

                                // Compute and send preprocessed spectrum
                                let analyzer = analyzers
                                    .entry(result.config_id.clone())
                                    .or_insert_with(|| SpectrumAnalyzer::with_bins(vad_bins));
                                let magnitudes = analyzer.compute(&result.preprocessed_samples);
                                let spectrum_msg = ServerMessage::PreprocessedSpectrum {
                                    config_id: result.config_id,
                                    timestamp_ms: result.timestamp_ms,
                                    magnitudes,
                                };
                                if msg_tx_vad.send(spectrum_msg).await.is_err() {
                                    break;
                                }
                            }
                        });

                        // Stream messages to the client until stop
                        // Maximum recording duration (configurable, default 2 minutes)
                        let max_duration =
                            tokio::time::sleep(std::time::Duration::from_secs(max_duration_secs));
                        tokio::pin!(max_duration);

                        loop {
                            tokio::select! {
                                Some(msg) = msg_rx.recv() => {
                                    if ws_tx.send(send_msg(&msg)).await.is_err() {
                                        break;
                                    }
                                }
                                incoming = ws_rx.next() => {
                                    match incoming {
                                        Some(Ok(Message::Text(text))) => {
                                            if let Ok(ClientMessage::StopRecording) = serde_json::from_str(&text) {
                                                if let Some(tx) = stop_tx.take() {
                                                    let _ = tx.send(());
                                                }
                                                tracing::info!("recording stopped");
                                                break;
                                            }
                                        }
                                        None | Some(Err(_)) => break, // client disconnected
                                        _ => {}
                                    }
                                }
                                () = &mut max_duration => {
                                    // Auto-stop after configured duration
                                    if let Some(tx) = stop_tx.take() {
                                        let _ = tx.send(());
                                    }
                                    tracing::info!(
                                        duration_secs = max_duration_secs,
                                        "recording auto-stopped after max duration"
                                    );
                                    let _ = ws_tx.send(send_msg(&ServerMessage::Done)).await;
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = ws_tx
                            .send(send_msg(&ServerMessage::Error { message: e }))
                            .await;
                    }
                }
            }

            ClientMessage::StopRecording => {
                if let Some(tx) = stop_tx.take() {
                    let _ = tx.send(());
                }
                tracing::info!("recording stopped");
            }

            ClientMessage::LoadFile { path, channel } => {
                // Load the WAV file (read + resample + truncate) — fast, no playback
                let file_path = std::path::Path::new(&path);
                let max_duration = Some(default_max_duration_secs());
                let loaded = match audio_source::load_wav(file_path, max_duration, channel) {
                    Ok(l) => l,
                    Err(e) => {
                        let _ = ws_tx
                            .send(send_msg(&ServerMessage::Error { message: e }))
                            .await;
                        continue;
                    }
                };

                let sample_rate = loaded.sample_rate;

                // Notify client of sample rate and spectrum info
                let _ = ws_tx
                    .send(send_msg(&ServerMessage::RecordingStarted {
                        sample_rate,
                        spectrum_bins,
                    }))
                    .await;

                // Broadcast channel large enough for all frames (no lag)
                let samples_per_frame = sample_rate as usize * frame_duration_ms as usize / 1000;
                let total_frames = loaded.samples.len() / samples_per_frame.max(1) + 16;
                let (audio_tx, _) = broadcast::channel::<AudioFrame>(total_frames.max(16));

                // Create VAD probability broadcast for pipeline mode
                let (vad_broadcast_tx, _) = broadcast::channel::<pipeline::VadProbability>(4096);
                let vad_broadcast = if pipeline_configs.is_empty() {
                    None
                } else {
                    Some(&vad_broadcast_tx)
                };

                // Start pipeline BEFORE emitting frames so it receives everything
                let result_rx =
                    pipeline::run_pipeline(&configs, &audio_tx, sample_rate, vad_broadcast);

                // Start turn detection BEFORE emitting frames
                let turn_rx = if !turn_configs.is_empty() {
                    Some(pipeline::run_turn_pipeline(
                        &turn_configs,
                        &audio_tx,
                        sample_rate,
                    ))
                } else {
                    None
                };

                // Start pipeline mode BEFORE emitting frames
                let pipeline_mode_rx = if !pipeline_configs.is_empty() {
                    Some(pipeline::run_pipeline_mode(
                        &pipeline_configs,
                        &turn_configs,
                        &audio_tx,
                        &vad_broadcast_tx,
                        sample_rate,
                    ))
                } else {
                    None
                };

                // Emit all frames at full speed (no sleep)
                audio_source::emit_frames(
                    &loaded.samples,
                    sample_rate,
                    frame_duration_ms,
                    &audio_tx,
                );
                // Drop senders so pipelines know the stream is finished
                drop(audio_tx);
                drop(vad_broadcast_tx);

                // Collect messages from audio + pipeline into one channel
                let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel::<ServerMessage>(512);

                // Task 1: Send audio + spectrum frames
                let msg_tx_audio = msg_tx.clone();
                let bins = spectrum_bins;
                let file_samples = loaded.samples;
                let sr = sample_rate;
                let spf = samples_per_frame;
                tokio::spawn(async move {
                    let mut analyzer = SpectrumAnalyzer::with_bins(bins);
                    let sample_rate_f = sr as f64;
                    let mut total_samples: u64 = 0;

                    for chunk in file_samples.chunks(spf) {
                        let timestamp_ms = (total_samples as f64 / sample_rate_f) * 1000.0;

                        let audio_msg = ServerMessage::Audio {
                            timestamp_ms,
                            samples: chunk.to_vec(),
                        };
                        if msg_tx_audio.send(audio_msg).await.is_err() {
                            break;
                        }

                        let magnitudes = analyzer.compute(chunk);
                        let spectrum_msg = ServerMessage::Spectrum {
                            timestamp_ms,
                            magnitudes,
                        };
                        if msg_tx_audio.send(spectrum_msg).await.is_err() {
                            break;
                        }

                        total_samples += chunk.len() as u64;
                    }
                });

                // Task 2: Forward turn detection results
                if let Some(mut turn_rx) = turn_rx {
                    let msg_tx_turn = msg_tx.clone();
                    tokio::spawn(async move {
                        while let Some(result) = turn_rx.recv().await {
                            let turn_msg = ServerMessage::Turn {
                                config_id: result.config_id,
                                timestamp_ms: result.timestamp_ms,
                                state: result.state,
                                confidence: result.confidence,
                                latency_ms: result.latency_ms,
                                stage_times: result.stage_times,
                            };
                            if msg_tx_turn.send(turn_msg).await.is_err() {
                                break;
                            }
                        }
                    });
                }

                // Task 3: Forward pipeline mode results
                if let Some(mut pipeline_mode_rx) = pipeline_mode_rx {
                    let msg_tx_pipeline = msg_tx.clone();
                    tokio::spawn(async move {
                        while let Some(result) = pipeline_mode_rx.recv().await {
                            let (event, turn_state, turn_confidence, turn_latency_ms) =
                                match &result.event {
                                    pipeline::PipelineModeEvent::SpeechStart => {
                                        ("speech_start".to_string(), None, None, None)
                                    }
                                    pipeline::PipelineModeEvent::SpeechEnd {
                                        turn_state,
                                        turn_confidence,
                                        turn_latency_ms,
                                    } => (
                                        "speech_end".to_string(),
                                        Some(turn_state.clone()),
                                        Some(*turn_confidence),
                                        Some(*turn_latency_ms),
                                    ),
                                };
                            let msg = ServerMessage::Pipeline {
                                config_id: result.config_id,
                                timestamp_ms: result.timestamp_ms,
                                event,
                                turn_state,
                                turn_confidence,
                                turn_latency_ms,
                            };
                            if msg_tx_pipeline.send(msg).await.is_err() {
                                break;
                            }
                        }
                    });
                }

                // Task 4: Forward VAD + preprocessed results
                let msg_tx_vad = msg_tx;
                let vad_bins = spectrum_bins;
                let mut result_rx = result_rx;
                tokio::spawn(async move {
                    let mut analyzers: std::collections::HashMap<String, SpectrumAnalyzer> =
                        std::collections::HashMap::new();

                    while let Some(result) = result_rx.recv().await {
                        let vad_msg = ServerMessage::Vad {
                            config_id: result.config_id.clone(),
                            timestamp_ms: result.timestamp_ms,
                            probability: result.probability,
                            inference_us: result.inference_us,
                            stage_times: result.stage_times.clone(),
                            frame_duration_ms: result.frame_duration_ms,
                        };
                        if msg_tx_vad.send(vad_msg).await.is_err() {
                            break;
                        }

                        let audio_msg = ServerMessage::PreprocessedAudio {
                            config_id: result.config_id.clone(),
                            timestamp_ms: result.timestamp_ms,
                            samples: result.preprocessed_samples.clone(),
                        };
                        if msg_tx_vad.send(audio_msg).await.is_err() {
                            break;
                        }

                        let pp_analyzer = analyzers
                            .entry(result.config_id.clone())
                            .or_insert_with(|| SpectrumAnalyzer::with_bins(vad_bins));
                        let magnitudes = pp_analyzer.compute(&result.preprocessed_samples);
                        let spectrum_msg = ServerMessage::PreprocessedSpectrum {
                            config_id: result.config_id,
                            timestamp_ms: result.timestamp_ms,
                            magnitudes,
                        };
                        if msg_tx_vad.send(spectrum_msg).await.is_err() {
                            break;
                        }
                    }
                });

                // Stream interleaved results to client;
                // Done when both tasks finish (all senders dropped)
                while let Some(msg) = msg_rx.recv().await {
                    if ws_tx.send(send_msg(&msg)).await.is_err() {
                        break;
                    }
                }
                let _ = ws_tx.send(send_msg(&ServerMessage::Done)).await;
            }
        }
    }

    // Cleanup
    if let Some(tx) = stop_tx.take() {
        let _ = tx.send(());
    }
}
