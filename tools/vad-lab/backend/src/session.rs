use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use wavekat_vad::preprocessing::PreprocessorConfig;

/// Configuration for a single VAD instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    /// Unique identifier for this config.
    pub id: String,
    /// Human-readable label (e.g., "webrtc-aggressive").
    pub label: String,
    /// Backend name: "webrtc" or "silero".
    pub backend: String,
    /// Backend-specific parameters.
    pub params: HashMap<String, serde_json::Value>,
    /// Preprocessing configuration. Defaults to no preprocessing.
    #[serde(default)]
    pub preprocessing: PreprocessorConfig,
}

/// A single VAD result for one frame.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadResult {
    /// Timestamp in milliseconds from the start of the audio.
    pub timestamp_ms: f64,
    /// Speech probability (0.0 - 1.0).
    pub probability: f32,
}

/// A complete session: configs, audio reference, and results.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// Session name.
    pub name: String,
    /// Path to the recorded/loaded WAV file.
    pub audio_path: Option<PathBuf>,
    /// Sample rate used.
    pub sample_rate: u32,
    /// VAD configurations used in this session.
    pub configs: Vec<VadConfig>,
    /// Results keyed by config ID.
    pub results: HashMap<String, Vec<VadResult>>,
}

#[allow(dead_code)]
impl Session {
    /// Create a new empty session.
    pub fn new(name: String, sample_rate: u32) -> Self {
        Self {
            name,
            audio_path: None,
            sample_rate,
            configs: Vec::new(),
            results: HashMap::new(),
        }
    }

    /// Save session to a JSON file.
    pub fn save(&self, path: &Path) -> Result<(), std::io::Error> {
        let json = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(path, json)
    }

    /// Load session from a JSON file.
    pub fn load(path: &Path) -> Result<Self, std::io::Error> {
        let json = std::fs::read_to_string(path)?;
        serde_json::from_str(&json).map_err(std::io::Error::other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_roundtrip() {
        let mut session = Session::new("test".into(), 16000);
        session.configs.push(VadConfig {
            id: "webrtc-1".into(),
            label: "WebRTC Quality".into(),
            backend: "webrtc".into(),
            params: HashMap::from([("mode".into(), serde_json::json!("0 - quality"))]),
            preprocessing: PreprocessorConfig::default(),
        });
        session.results.insert(
            "webrtc-1".into(),
            vec![VadResult {
                timestamp_ms: 0.0,
                probability: 0.0,
            }],
        );

        let dir = std::env::temp_dir();
        let path = dir.join("test_session.json");
        session.save(&path).unwrap();

        let loaded = Session::load(&path).unwrap();
        assert_eq!(loaded.name, "test");
        assert_eq!(loaded.configs.len(), 1);
        assert_eq!(loaded.results.len(), 1);

        std::fs::remove_file(&path).unwrap();
    }
}
