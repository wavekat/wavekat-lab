import { useRef, useEffect, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type Viewport,
  pixelToTime,
  timeToPixel,
  panViewport,
  zoomViewport,
} from "@/lib/viewport";

interface SpectrumFrame {
  timestamp_ms: number;
  magnitudes: number[];
}

interface FrequencySpectrumProps {
  /** Array of spectrum frames over time */
  spectrumData: SpectrumFrame[];
  /** Sample rate in Hz, used to calculate frequency labels */
  sampleRate: number;
  /** Total duration of the recording in ms */
  totalDurationMs: number;
  /** Current viewport (time window) */
  viewport: Viewport;
  /** Callback when viewport changes */
  onViewportChange: (viewport: Viewport) => void;
  /** Width of the canvas in pixels */
  width?: number;
  /** Height of the canvas in pixels */
  height?: number;
  /** Additional CSS classes */
  className?: string;
  /** Current hover time for crosshair sync */
  hoverTimeMs?: number | null;
  /** Callback when hover time changes */
  onHoverTimeChange?: (timeMs: number | null) => void;
  /** Whether we're in recording mode (anchors view to right edge) */
  recording?: boolean;
  /** Current number of frequency bins */
  bins?: number;
  /** Callback when bins setting changes */
  onBinsChange?: (bins: number) => void;
  /** Current playhead position in milliseconds (for playback) */
  playheadMs?: number | null;
}

type FreqScale = "linear" | "log" | "mel";

/** Convert linear frequency to logarithmic position (0-1) */
function freqToLogPosition(freq: number, minFreq: number, maxFreq: number): number {
  if (freq <= minFreq) return 0;
  if (freq >= maxFreq) return 1;
  return Math.log(freq / minFreq) / Math.log(maxFreq / minFreq);
}

/** Convert frequency (Hz) to mel scale */
function hzToMel(freq: number): number {
  return 2595 * Math.log10(1 + freq / 700);
}

/** Convert mel to frequency (Hz) */
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

/** Convert linear frequency to mel position (0-1) */
function freqToMelPosition(freq: number, minFreq: number, maxFreq: number): number {
  if (freq <= minFreq) return 0;
  if (freq >= maxFreq) return 1;
  const minMel = hzToMel(minFreq);
  const maxMel = hzToMel(maxFreq);
  const mel = hzToMel(freq);
  return (mel - minMel) / (maxMel - minMel);
}

/** Convert mel position (0-1) to frequency (Hz) */
function melPositionToFreq(pos: number, minFreq: number, maxFreq: number): number {
  const minMel = hzToMel(minFreq);
  const maxMel = hzToMel(maxFreq);
  const mel = minMel + pos * (maxMel - minMel);
  return melToHz(mel);
}

/** Map dB value to RGB color components with configurable range
 * Uses Audacity-like colormap: dark blue -> blue -> cyan -> green -> yellow -> orange -> red -> white
 */
function dbToRgb(db: number, minDb: number, maxDb: number): [number, number, number] {
  // Normalize to 0-1 based on the dB range
  const range = maxDb - minDb;
  const normalized = (db - minDb) / range;
  const clamped = Math.max(0, Math.min(1, normalized));

  // Apply slight gamma curve for better perceptual distribution
  const t = Math.pow(clamped, 0.85);

  // Audacity-style colormap with more color variation
  // 0.0: dark blue/black (silence)
  // 0.15: deep blue
  // 0.3: blue-cyan
  // 0.45: cyan-green
  // 0.6: green-yellow
  // 0.75: yellow-orange
  // 0.9: orange-red
  // 1.0: white (loud)

  if (t < 0.1) {
    // Black to dark blue
    const s = t / 0.1;
    return [0, 0, Math.round(30 + s * 60)];
  } else if (t < 0.25) {
    // Dark blue to blue
    const s = (t - 0.1) / 0.15;
    return [0, Math.round(s * 50), Math.round(90 + s * 120)];
  } else if (t < 0.4) {
    // Blue to cyan
    const s = (t - 0.25) / 0.15;
    return [0, Math.round(50 + s * 155), Math.round(210 - s * 10)];
  } else if (t < 0.55) {
    // Cyan to green
    const s = (t - 0.4) / 0.15;
    return [Math.round(s * 50), Math.round(205 - s * 30), Math.round(200 - s * 150)];
  } else if (t < 0.7) {
    // Green to yellow
    const s = (t - 0.55) / 0.15;
    return [Math.round(50 + s * 205), Math.round(175 + s * 80), Math.round(50 - s * 50)];
  } else if (t < 0.85) {
    // Yellow to orange/red
    const s = (t - 0.7) / 0.15;
    return [255, Math.round(255 - s * 120), 0];
  } else {
    // Red to white
    const s = (t - 0.85) / 0.15;
    return [255, Math.round(135 + s * 120), Math.round(s * 255)];
  }
}

/** Convert log position (0-1) to frequency */
function logPositionToFreq(pos: number, minFreq: number, maxFreq: number): number {
  return minFreq * Math.pow(maxFreq / minFreq, pos);
}

const BINS_OPTIONS = [32, 64, 128, 256, 512];
// Gain options - higher gain makes quiet sounds more visible
// by compressing the dB range (loud sounds clip to bright)
const GAIN_OPTIONS = [
  { label: "0dB", minDb: -120, maxDb: 0 },    // Full 120dB range, no boost
  { label: "+20dB", minDb: -120, maxDb: -20 }, // 100dB range, slight boost
  { label: "+40dB", minDb: -120, maxDb: -40 }, // 80dB range, moderate boost
  { label: "+60dB", minDb: -120, maxDb: -60 }, // 60dB range, high boost - quiet sounds visible
];

export function FrequencySpectrum({
  spectrumData,
  sampleRate,
  totalDurationMs,
  viewport,
  onViewportChange,
  width = 800,
  height = 150,
  className,
  hoverTimeMs,
  onHoverTimeChange,
  recording = false,
  bins = 64,
  onBinsChange,
  playheadMs,
}: FrequencySpectrumProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [freqScale, setFreqScale] = useState<FreqScale>("mel");
  const [gain, setGain] = useState(2); // Index into GAIN_OPTIONS (default +20dB for better detail)
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; viewStartMs: number } | null>(null);

  // Frequency range
  const minFreq = 20; // 20 Hz
  const maxFreq = sampleRate / 2; // Nyquist frequency
  const numBins = spectrumData.length > 0 ? spectrumData[0].magnitudes.length : 512;
  const freqPerBin = sampleRate / (numBins * 2);

  // During recording, anchor "now" to the right edge
  const effectiveViewport = recording
    ? {
        viewStartMs: totalDurationMs - viewport.viewDurationMs,
        viewDurationMs: viewport.viewDurationMs,
      }
    : viewport;

  // Get current dB range from gain
  const { minDb, maxDb } = GAIN_OPTIONS[gain];

  // Refs for throttled rendering
  const rafIdRef = useRef<number | null>(null);
  const lastRenderRef = useRef<{
    dataLength: number;
    viewStartMs: number;
    viewDurationMs: number;
    freqScale: FreqScale;
    gain: number;
    hoverTimeMs: number | null;
    playheadMs: number | null;
  } | null>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Use 1:1 pixel mapping for crisp image rendering
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.clearRect(0, 0, width, height);

    // Dark background
    ctx.fillStyle = "#0d0d1a";
    ctx.fillRect(0, 0, width, height);

    if (spectrumData.length === 0) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No spectrum data", width / 2, height / 2);
      return;
    }

    // Sort frames by timestamp for binary search
    const sortedFrames = [...spectrumData].sort((a, b) => a.timestamp_ms - b.timestamp_ms);

    // Create ImageData for pixel-by-pixel rendering
    const imageData = ctx.createImageData(width, height);
    const pixels = imageData.data;

    // Helper to get magnitude from frame with frequency interpolation
    const getMagnitude = (frame: SpectrumFrame, freq: number): number => {
      const binFloat = freq / freqPerBin;
      const binLow = Math.floor(binFloat);
      const binHigh = Math.ceil(binFloat);
      const binFrac = binFloat - binLow;

      if (binLow < 0 || binHigh >= frame.magnitudes.length) {
        return -120;
      } else if (binLow === binHigh) {
        return frame.magnitudes[binLow];
      } else {
        const dbLow = frame.magnitudes[binLow];
        const dbHigh = frame.magnitudes[binHigh];
        return dbLow + (dbHigh - dbLow) * binFrac;
      }
    };

    // For each pixel, sample the spectrum with bilinear interpolation
    for (let px = 0; px < width; px++) {
      // Map pixel X to time
      const timeMs = pixelToTime(px, width, effectiveViewport);

      // Find the two closest frames for time interpolation
      let frameIdxLow = -1;
      let frameIdxHigh = -1;
      for (let i = 0; i < sortedFrames.length; i++) {
        if (sortedFrames[i].timestamp_ms <= timeMs) {
          frameIdxLow = i;
        }
        if (sortedFrames[i].timestamp_ms >= timeMs && frameIdxHigh === -1) {
          frameIdxHigh = i;
          break;
        }
      }

      // Handle edge cases: skip pixels outside the data range
      if (frameIdxLow === -1 && frameIdxHigh === -1) continue;
      if (frameIdxLow === -1) frameIdxLow = frameIdxHigh;
      if (frameIdxHigh === -1) continue;

      const frameLow = sortedFrames[frameIdxLow];
      const frameHigh = sortedFrames[frameIdxHigh];
      if (!frameLow || !frameHigh) continue;

      // Calculate time interpolation factor
      let timeFrac = 0;
      if (frameIdxLow !== frameIdxHigh) {
        const timeDiff = frameHigh.timestamp_ms - frameLow.timestamp_ms;
        if (timeDiff > 0) {
          timeFrac = (timeMs - frameLow.timestamp_ms) / timeDiff;
        }
      }

      for (let py = 0; py < height; py++) {
        // Map pixel Y to frequency (Y is inverted: 0 = top = high freq)
        const yNorm = 1 - py / height;

        let freq: number;
        if (freqScale === "log") {
          freq = logPositionToFreq(yNorm, minFreq, maxFreq);
        } else if (freqScale === "mel") {
          freq = melPositionToFreq(yNorm, minFreq, maxFreq);
        } else {
          freq = yNorm * maxFreq;
        }

        // Get magnitude with bilinear interpolation (time + frequency)
        let db: number;
        if (frameIdxLow === frameIdxHigh) {
          // No time interpolation needed
          db = getMagnitude(frameLow, freq);
        } else {
          // Interpolate between two frames
          const dbLow = getMagnitude(frameLow, freq);
          const dbHigh = getMagnitude(frameHigh, freq);
          db = dbLow + (dbHigh - dbLow) * timeFrac;
        }

        // Convert to color and set pixel
        const [r, g, b] = dbToRgb(db, minDb, maxDb);
        const idx = (py * width + px) * 4;
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
      }
    }

    // Draw the spectrogram image
    ctx.putImageData(imageData, 0, 0);

    // Draw frequency grid lines on top
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.lineWidth = 1;
    ctx.font = "10px monospace";
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.textAlign = "left";

    const gridFreqs = [100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    for (const freq of gridFreqs) {
      if (freq > maxFreq) continue;

      let yNorm: number;
      if (freqScale === "log") {
        yNorm = freqToLogPosition(freq, minFreq, maxFreq);
      } else if (freqScale === "mel") {
        yNorm = freqToMelPosition(freq, minFreq, maxFreq);
      } else {
        yNorm = freq / maxFreq;
      }

      const y = Math.round(height * (1 - yNorm));
      if (y > 10 && y < height - 5) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();

        const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
        ctx.fillText(label, 4, y - 3);
      }
    }

    // Draw hover crosshair and dB slice line
    if (hoverTimeMs != null && totalDurationMs > 0) {
      const x = timeToPixel(hoverTimeMs, width, effectiveViewport);

      if (x >= 0 && x <= width) {
        ctx.strokeStyle = "#f97316";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();

        const timeStr = (hoverTimeMs / 1000).toFixed(3) + "s";
        ctx.font = "11px monospace";
        ctx.fillStyle = "#f97316";
        const textWidth = ctx.measureText(timeStr).width;
        const labelX = x + 4 > width - textWidth - 4 ? x - textWidth - 4 : x + 4;
        ctx.fillText(timeStr, labelX, 12);

        // Draw dB slice line next to crosshair
        if (spectrumData.length > 0) {
          // Find closest frame
          let closestFrame = sortedFrames[0];
          let minDiff = Math.abs(sortedFrames[0].timestamp_ms - hoverTimeMs);
          for (const frame of sortedFrames) {
            const diff = Math.abs(frame.timestamp_ms - hoverTimeMs);
            if (diff < minDiff) {
              minDiff = diff;
              closestFrame = frame;
            }
          }

          if (closestFrame) {
            const magnitudes = closestFrame.magnitudes;
            const numBinsLocal = magnitudes.length;
            const freqPerBinLocal = sampleRate / (numBinsLocal * 2);
            const dbRange = maxDb - minDb;
            const sliceWidth = 60; // Width of the dB slice visualization
            const flipLeft = x + sliceWidth + 4 > width;

            // Build the path points
            const points: { x: number; y: number }[] = [];
            for (let py = 0; py < height; py++) {
              const yNorm = 1 - py / height;

              let freq: number;
              if (freqScale === "log") {
                freq = logPositionToFreq(yNorm, minFreq, maxFreq);
              } else if (freqScale === "mel") {
                freq = melPositionToFreq(yNorm, minFreq, maxFreq);
              } else {
                freq = yNorm * maxFreq;
              }

              // Get magnitude with interpolation
              const binFloat = freq / freqPerBinLocal;
              const binLow = Math.floor(binFloat);
              const binHigh = Math.ceil(binFloat);
              const binFrac = binFloat - binLow;

              let db: number;
              if (binLow < 0 || binHigh >= magnitudes.length) {
                db = -120;
              } else if (binLow === binHigh) {
                db = magnitudes[binLow];
              } else {
                db = magnitudes[binLow] + (magnitudes[binHigh] - magnitudes[binLow]) * binFrac;
              }

              // Map dB to X offset from crosshair
              const xNorm = Math.max(0, Math.min(1, (db - minDb) / dbRange));
              const xOffset = xNorm * sliceWidth;
              const lineX = flipLeft ? x - 2 - xOffset : x + 2 + xOffset;
              points.push({ x: lineX, y: py });
            }

            // Draw dark outline first
            ctx.strokeStyle = "#000000";
            ctx.lineWidth = 3;
            ctx.beginPath();
            points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
            ctx.stroke();

            // Draw white line on top
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
            ctx.stroke();
          }
        }
      }
    }

    // Draw playhead
    if (playheadMs != null && totalDurationMs > 0) {
      const x = timeToPixel(playheadMs, width, effectiveViewport);

      if (x >= 0 && x <= width) {
        // Playhead line (bright blue)
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();

        // Playhead triangle at top
        ctx.fillStyle = "#3b82f6";
        ctx.beginPath();
        ctx.moveTo(x - 6, 0);
        ctx.lineTo(x + 6, 0);
        ctx.lineTo(x, 8);
        ctx.closePath();
        ctx.fill();
      }
    }
  }, [
    spectrumData,
    width,
    height,
    effectiveViewport,
    freqScale,
    minDb,
    maxDb,
    hoverTimeMs,
    playheadMs,
    totalDurationMs,
    minFreq,
    maxFreq,
    freqPerBin,
    sampleRate,
  ]);

  // Throttled render with requestAnimationFrame
  useEffect(() => {
    const currentState = {
      dataLength: spectrumData.length,
      viewStartMs: effectiveViewport.viewStartMs,
      viewDurationMs: effectiveViewport.viewDurationMs,
      freqScale,
      gain,
      hoverTimeMs: hoverTimeMs ?? null,
      playheadMs: playheadMs ?? null,
    };

    const lastRender = lastRenderRef.current;
    if (
      lastRender &&
      lastRender.dataLength === currentState.dataLength &&
      lastRender.viewStartMs === currentState.viewStartMs &&
      lastRender.viewDurationMs === currentState.viewDurationMs &&
      lastRender.gain === currentState.gain &&
      lastRender.freqScale === currentState.freqScale &&
      lastRender.hoverTimeMs === currentState.hoverTimeMs &&
      lastRender.playheadMs === currentState.playheadMs
    ) {
      return;
    }

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }

    rafIdRef.current = requestAnimationFrame(() => {
      render();
      lastRenderRef.current = currentState;
      rafIdRef.current = null;
    });

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [
    spectrumData.length,
    effectiveViewport.viewStartMs,
    effectiveViewport.viewDurationMs,
    freqScale,
    gain,
    hoverTimeMs,
    playheadMs,
    render,
  ]);

  // Force re-render when dimensions change
  useEffect(() => {
    lastRenderRef.current = null;
  }, [width, height, sampleRate]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isDragging && dragStartRef.current) {
        const deltaX = e.clientX - dragStartRef.current.x;
        const newViewport = panViewport(
          { ...viewport, viewStartMs: dragStartRef.current.viewStartMs },
          deltaX,
          width,
          totalDurationMs
        );
        onViewportChange(newViewport);
        return;
      }

      if (!onHoverTimeChange) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const timeMs = pixelToTime(x, width, effectiveViewport);
      onHoverTimeChange(Math.max(0, Math.min(totalDurationMs, timeMs)));
    },
    [
      isDragging,
      viewport,
      width,
      totalDurationMs,
      onViewportChange,
      onHoverTimeChange,
      effectiveViewport,
    ]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (recording) return;
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, viewStartMs: viewport.viewStartMs };
    },
    [recording, viewport.viewStartMs]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current = null;
  }, []);

  const handleMouseLeave = useCallback(() => {
    onHoverTimeChange?.(null);
    if (isDragging) {
      setIsDragging(false);
      dragStartRef.current = null;
    }
  }, [onHoverTimeChange, isDragging]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (recording) return;
      if (!e.ctrlKey && !e.metaKey) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const centerTimeMs = pixelToTime(x, width, effectiveViewport);

      const zoomIn = e.deltaY < 0;
      const newViewport = zoomViewport(viewport, centerTimeMs, zoomIn, totalDurationMs);
      onViewportChange(newViewport);
    },
    [recording, width, viewport, effectiveViewport, totalDurationMs, onViewportChange]
  );

  const cursor = recording ? "default" : isDragging ? "grabbing" : "grab";

  return (
    <div>
      <div className="flex items-center gap-4 mb-1">
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Freq scale:</span>
          <div className="inline-flex rounded-md border border-input">
            <Button
              variant="ghost"
              size="xs"
              className={`rounded-none rounded-l-md border-0 ${
                freqScale === "linear" ? "bg-accent text-accent-foreground" : ""
              }`}
              onClick={() => setFreqScale("linear")}
            >
              Linear
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className={`rounded-none border-0 border-l border-input ${
                freqScale === "log" ? "bg-accent text-accent-foreground" : ""
              }`}
              onClick={() => setFreqScale("log")}
            >
              Log
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className={`rounded-none rounded-r-md border-0 border-l border-input ${
                freqScale === "mel" ? "bg-accent text-accent-foreground" : ""
              }`}
              onClick={() => setFreqScale("mel")}
            >
              Mel
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Bins:</span>
          <Select
            value={String(bins)}
            onValueChange={(v) => { if (v) onBinsChange?.(parseInt(v)); }}
            disabled={recording}
          >
            <SelectTrigger className="h-6 w-16 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BINS_OPTIONS.map((b) => (
                <SelectItem key={b} value={String(b)}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Gain:</span>
          <div className="inline-flex rounded-md border border-input">
            {GAIN_OPTIONS.map((opt, idx) => (
              <Button
                key={opt.label}
                variant="ghost"
                size="xs"
                className={`border-0 ${
                  idx === 0 ? "rounded-l-md" : ""
                } ${
                  idx === GAIN_OPTIONS.length - 1 ? "rounded-r-md" : "border-r border-input"
                } ${
                  gain === idx ? "bg-accent text-accent-foreground" : ""
                }`}
                onClick={() => setGain(idx)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>
        <span className="text-xs text-muted-foreground">
          {(maxFreq / 1000).toFixed(1)}kHz max
        </span>
      </div>
      <div
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        style={{ width, height, cursor }}
      >
        <canvas
          ref={canvasRef}
          style={{ width, height }}
          className={className}
        />
      </div>
    </div>
  );
}
