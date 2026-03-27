import { useRef, useEffect, useState, useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  type Viewport,
  pixelToTime,
  timeToPixel,
  panViewport,
  zoomViewport,
} from "@/lib/viewport";

interface WaveformProps {
  samples: number[];
  totalDurationMs: number;
  /** Sample rate in Hz, used for accurate time-to-sample mapping */
  sampleRate?: number | null;
  viewport: Viewport;
  onViewportChange: (viewport: Viewport) => void;
  width?: number;
  height?: number;
  className?: string;
  hoverTimeMs?: number | null;
  onHoverTimeChange?: (timeMs: number | null) => void;
  interactionEnabled?: boolean;
  /** When true, "now" is anchored to right edge */
  recording?: boolean;
  /** Current playhead position in milliseconds (for playback) */
  playheadMs?: number | null;
  /** Called when user clicks to seek */
  onSeek?: (timeMs: number) => void;
  /** Additional controls to render on the right side of the controls row */
  rightControls?: ReactNode;
}

const VERTICAL_ZOOM_LEVELS = [1, 2, 4, 8, 16, 32];

/** Convert linear amplitude to logarithmic scale for better visibility of quiet sounds */
function toLogScale(value: number): number {
  const sign = Math.sign(value);
  const abs = Math.abs(value);
  const scale = 100;
  return sign * (Math.log1p(abs * scale) / Math.log1p(scale));
}

export function Waveform({
  samples,
  totalDurationMs,
  sampleRate,
  viewport,
  onViewportChange,
  width = 800,
  height = 150,
  className,
  hoverTimeMs,
  onHoverTimeChange,
  interactionEnabled = true,
  recording = false,
  playheadMs,
  onSeek,
  rightControls,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [verticalZoomIndex, setVerticalZoomIndex] = useState(0);
  const verticalZoom = VERTICAL_ZOOM_LEVELS[verticalZoomIndex];
  const [scaleMode, setScaleMode] = useState<"linear" | "log">("log");

  // Refs for throttled rendering
  const rafIdRef = useRef<number | null>(null);
  const lastRenderRef = useRef<{
    samplesLength: number;
    viewStartMs: number;
    viewDurationMs: number;
    verticalZoom: number;
    scaleMode: "linear" | "log";
    hoverTimeMs: number | null;
    playheadMs: number | null;
  } | null>(null);

  // During recording, anchor "now" to the right edge
  const effectiveViewport = recording
    ? {
        viewStartMs: totalDurationMs - viewport.viewDurationMs,
        viewDurationMs: viewport.viewDurationMs,
      }
    : viewport;

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; viewStartMs: number } | null>(null);
  const clickThreshold = 3; // pixels - if mouse moves less than this, it's a click

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isDragging && dragStartRef.current && interactionEnabled) {
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
      onHoverTimeChange,
      totalDurationMs,
      width,
      viewport,
      effectiveViewport,
      isDragging,
      interactionEnabled,
      onViewportChange,
    ]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!interactionEnabled) return;
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, viewStartMs: viewport.viewStartMs };
    },
    [interactionEnabled, viewport.viewStartMs]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (dragStartRef.current && onSeek && interactionEnabled) {
        const deltaX = Math.abs(e.clientX - dragStartRef.current.x);
        // If mouse didn't move much, treat as a click to seek
        if (deltaX < clickThreshold) {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const timeMs = pixelToTime(x, width, effectiveViewport);
          const clampedTime = Math.max(0, Math.min(totalDurationMs, timeMs));
          onSeek(clampedTime);
        }
      }
      setIsDragging(false);
      dragStartRef.current = null;
    },
    [onSeek, interactionEnabled, width, effectiveViewport, totalDurationMs]
  );

  const handleMouseLeave = useCallback(() => {
    onHoverTimeChange?.(null);
    if (isDragging) {
      setIsDragging(false);
      dragStartRef.current = null;
    }
  }, [onHoverTimeChange, isDragging]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!interactionEnabled) return;
      if (!e.ctrlKey && !e.metaKey) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const centerTimeMs = pixelToTime(x, width, effectiveViewport);

      const zoomIn = e.deltaY < 0;
      const newViewport = zoomViewport(
        viewport,
        centerTimeMs,
        zoomIn,
        totalDurationMs
      );
      onViewportChange(newViewport);
    },
    [interactionEnabled, width, viewport, effectiveViewport, totalDurationMs, onViewportChange]
  );

  // Render function
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    // Only resize canvas if dimensions changed
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
    } else {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;
    const samplesPerMs = sampleRate
      ? sampleRate / 1000
      : totalDurationMs > 0
        ? samples.length / totalDurationMs
        : 48;

    // Draw light grey background for recorded area
    if (totalDurationMs > 0) {
      const recordedStartX = Math.max(
        0,
        ((0 - effectiveViewport.viewStartMs) / effectiveViewport.viewDurationMs) * width
      );
      const recordedEndX = Math.min(
        width,
        ((totalDurationMs - effectiveViewport.viewStartMs) / effectiveViewport.viewDurationMs) * width
      );
      if (recordedEndX > recordedStartX) {
        ctx.fillStyle = "#f3f4f6";
        ctx.fillRect(recordedStartX, 0, recordedEndX - recordedStartX, height);
      }
    }

    // Calculate visible samples
    const viewStartSample = Math.floor(effectiveViewport.viewStartMs * samplesPerMs);
    const viewEndSample = Math.floor(
      (effectiveViewport.viewStartMs + effectiveViewport.viewDurationMs) * samplesPerMs
    );
    const visibleSampleCount = viewEndSample - viewStartSample;
    const samplesPerPixel = Math.max(1, Math.floor(visibleSampleCount / width));

    // Draw waveform
    ctx.strokeStyle = "#6366f1";
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let x = 0; x < width; x++) {
      const sampleStart = viewStartSample + x * samplesPerPixel;
      const sampleEnd = Math.min(sampleStart + samplesPerPixel, samples.length);

      if (sampleStart >= samples.length || sampleStart < 0) continue;

      let min = 0;
      let max = 0;
      for (let i = Math.max(0, sampleStart); i < sampleEnd; i++) {
        const val = samples[i] / 32768;
        if (val < min) min = val;
        if (val > max) max = val;
      }

      const scaledMin = scaleMode === "log" ? toLogScale(min) : min;
      const scaledMax = scaleMode === "log" ? toLogScale(max) : max;

      const yMin = Math.max(0, mid + scaledMin * mid * verticalZoom);
      const yMax = Math.min(height, mid + scaledMax * mid * verticalZoom);

      ctx.moveTo(x, yMin);
      ctx.lineTo(x, yMax);
    }

    ctx.stroke();

    // Clipping indicator
    if (verticalZoom > 1) {
      ctx.strokeStyle = "rgba(239, 68, 68, 0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, 0.5);
      ctx.lineTo(width, 0.5);
      ctx.moveTo(0, height - 0.5);
      ctx.lineTo(width, height - 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Center line
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    // Draw crosshair
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
  }, [samples, width, height, verticalZoom, hoverTimeMs, playheadMs, totalDurationMs, effectiveViewport, sampleRate, scaleMode]);

  // Throttled render with requestAnimationFrame
  useEffect(() => {
    // Check if we actually need to re-render
    const currentState = {
      samplesLength: samples.length,
      viewStartMs: effectiveViewport.viewStartMs,
      viewDurationMs: effectiveViewport.viewDurationMs,
      verticalZoom,
      scaleMode,
      hoverTimeMs: hoverTimeMs ?? null,
      playheadMs: playheadMs ?? null,
    };

    const lastRender = lastRenderRef.current;
    if (
      lastRender &&
      lastRender.samplesLength === currentState.samplesLength &&
      lastRender.viewStartMs === currentState.viewStartMs &&
      lastRender.viewDurationMs === currentState.viewDurationMs &&
      lastRender.verticalZoom === currentState.verticalZoom &&
      lastRender.scaleMode === currentState.scaleMode &&
      lastRender.hoverTimeMs === currentState.hoverTimeMs &&
      lastRender.playheadMs === currentState.playheadMs
    ) {
      return; // Skip if nothing changed
    }

    // Cancel any pending render
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }

    // Schedule render on next animation frame
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
  }, [samples.length, effectiveViewport.viewStartMs, effectiveViewport.viewDurationMs, verticalZoom, scaleMode, hoverTimeMs, playheadMs, render]);

  // Force re-render when width/height/sampleRate changes
  useEffect(() => {
    lastRenderRef.current = null; // Invalidate cache
  }, [width, height, sampleRate]);

  const cursor = !interactionEnabled
    ? "default"
    : isDragging
      ? "grabbing"
      : "grab";

  return (
    <div>
      <div className="flex items-center justify-between gap-4 mb-1">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Amplitude:</span>
          <Button
            variant="outline"
            size="xs"
            disabled={verticalZoomIndex <= 0}
            onClick={() => setVerticalZoomIndex((i) => Math.max(0, i - 1))}
          >
            −
          </Button>
          <span className="text-xs text-muted-foreground w-10 text-center">
            {verticalZoom}x
          </span>
          <Button
            variant="outline"
            size="xs"
            disabled={verticalZoomIndex >= VERTICAL_ZOOM_LEVELS.length - 1}
            onClick={() =>
              setVerticalZoomIndex((i) =>
                Math.min(VERTICAL_ZOOM_LEVELS.length - 1, i + 1)
              )
            }
          >
            +
          </Button>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Scale:</span>
            <div className="inline-flex rounded-md border border-input">
              <Button
                variant="ghost"
                size="xs"
                className={`rounded-none rounded-l-md border-0 ${
                  scaleMode === "linear"
                    ? "bg-accent text-accent-foreground"
                    : ""
                }`}
                onClick={() => setScaleMode("linear")}
              >
                Linear
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className={`rounded-none rounded-r-md border-0 border-l border-input ${
                  scaleMode === "log"
                    ? "bg-accent text-accent-foreground"
                    : ""
                }`}
                onClick={() => setScaleMode("log")}
              >
                Log
              </Button>
            </div>
          </div>
        </div>
        {rightControls}
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
