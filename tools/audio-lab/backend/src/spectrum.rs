//! FFT-based spectrum analysis for audio frames.

use rustfft::{num_complex::Complex, FftPlanner};

/// Size of the FFT window (power of 2 for efficiency).
const FFT_SIZE: usize = 1024;

/// Number of raw FFT bins (half of FFT_SIZE, positive frequencies only).
const RAW_BINS: usize = FFT_SIZE / 2;

/// Default number of output bins for smooth spectrogram display.
pub const DEFAULT_OUTPUT_BINS: usize = 256;

/// Computes the magnitude spectrum of audio samples.
///
/// Internally uses a 1024-point FFT for good frequency resolution,
/// then aggregates into configurable output bins for efficient transmission.
/// Magnitudes are in dB scale (20 * log10(magnitude)), clamped to [-80, 0] dB.
///
/// Note: Bins are always linearly distributed. For log frequency display,
/// the frontend should handle the Y-axis scaling - this gives more screen
/// space to lower frequencies without reducing their energy values.
pub struct SpectrumAnalyzer {
    planner: FftPlanner<f32>,
    buffer: Vec<Complex<f32>>,
    window: Vec<f32>,
    raw_magnitudes: Vec<f32>,
    output_bins: usize,
}

impl SpectrumAnalyzer {
    /// Create a new spectrum analyzer with the default settings (64 bins).
    pub fn new() -> Self {
        Self::with_bins(DEFAULT_OUTPUT_BINS)
    }

    /// Create a new spectrum analyzer with a custom number of output bins.
    ///
    /// `output_bins` should be a power of 2 and divide evenly into 512.
    /// Common values: 32, 64, 128, 256, 512.
    pub fn with_bins(output_bins: usize) -> Self {
        // Hann window for smoother spectral analysis
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| {
                let x = std::f32::consts::PI * 2.0 * i as f32 / (FFT_SIZE - 1) as f32;
                0.5 * (1.0 - x.cos())
            })
            .collect();

        Self {
            planner: FftPlanner::new(),
            buffer: vec![Complex::new(0.0, 0.0); FFT_SIZE],
            window,
            raw_magnitudes: vec![0.0; RAW_BINS],
            output_bins,
        }
    }

    /// Returns the number of output bins this analyzer produces.
    #[allow(dead_code)]
    pub fn num_bins(&self) -> usize {
        self.output_bins
    }

    /// Compute the magnitude spectrum of the given samples.
    ///
    /// Returns `output_bins` magnitude values in dB scale.
    /// If samples is shorter than FFT_SIZE, it will be zero-padded.
    /// If longer, only the last FFT_SIZE samples are used.
    pub fn compute(&mut self, samples: &[i16]) -> Vec<f32> {
        // Fill buffer with windowed samples
        let start = if samples.len() > FFT_SIZE {
            samples.len() - FFT_SIZE
        } else {
            0
        };
        let relevant_samples = &samples[start..];

        for i in 0..FFT_SIZE {
            let sample = if i < relevant_samples.len() {
                relevant_samples[i] as f32 / 32768.0
            } else {
                0.0
            };
            self.buffer[i] = Complex::new(sample * self.window[i], 0.0);
        }

        // Perform FFT
        let fft = self.planner.plan_fft_forward(FFT_SIZE);
        fft.process(&mut self.buffer);

        // Compute raw magnitudes
        for i in 0..RAW_BINS {
            let magnitude = self.buffer[i].norm() / (FFT_SIZE as f32);
            self.raw_magnitudes[i] = magnitude;
        }

        // Aggregate into output bins (linear distribution, take max for peak detection)
        let bins_per_output = RAW_BINS / self.output_bins;
        let mut output = Vec::with_capacity(self.output_bins);

        for out_idx in 0..self.output_bins {
            let start_bin = out_idx * bins_per_output;
            let end_bin = start_bin + bins_per_output;

            let max_mag = self.raw_magnitudes[start_bin..end_bin]
                .iter()
                .fold(0.0_f32, |acc, &m| acc.max(m));

            // Convert to dB, clamp to [-120, 0]
            let db = if max_mag > 0.0 {
                (20.0 * max_mag.log10()).clamp(-120.0, 0.0)
            } else {
                -120.0
            };
            output.push(db);
        }

        output
    }
}

impl Default for SpectrumAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spectrum_analyzer_basic() {
        let mut analyzer = SpectrumAnalyzer::new();

        // Silent input should produce very low magnitudes (at the floor)
        let silent: Vec<i16> = vec![0; 960];
        let spectrum = analyzer.compute(&silent);
        assert_eq!(spectrum.len(), DEFAULT_OUTPUT_BINS);
        for &mag in &spectrum {
            assert!(mag <= -110.0, "silent input should have low magnitude");
        }
    }

    #[test]
    fn test_spectrum_analyzer_sine_wave() {
        // Use 512 bins so we can check exact bin position
        let mut analyzer = SpectrumAnalyzer::with_bins(512);

        // Generate a 1kHz sine wave at 48kHz sample rate
        let sample_rate = 48000.0;
        let freq = 1000.0;
        let samples: Vec<i16> = (0..FFT_SIZE)
            .map(|i| {
                let t = i as f32 / sample_rate;
                (0.5 * (2.0 * std::f32::consts::PI * freq * t).sin() * 32767.0) as i16
            })
            .collect();

        let spectrum = analyzer.compute(&samples);
        assert_eq!(spectrum.len(), 512);

        // Expected bin for 1kHz: 1000 / (48000 / 1024) ≈ 21.3
        // Should see a peak around bin 21
        let peak_bin = spectrum
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
            .map(|(i, _)| i)
            .unwrap();

        assert!(
            (20..=23).contains(&peak_bin),
            "peak should be around bin 21, got {}",
            peak_bin
        );
    }

    #[test]
    fn test_custom_bins() {
        let analyzer = SpectrumAnalyzer::with_bins(128);
        assert_eq!(analyzer.num_bins(), 128);

        let analyzer = SpectrumAnalyzer::new();
        assert_eq!(analyzer.num_bins(), DEFAULT_OUTPUT_BINS);
    }
}
