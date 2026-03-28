import { useRef, useEffect, useCallback } from "react";
import { type Viewport, pixelToTime, timeToPixel } from "@/lib/viewport";

export interface TurnResultPoint {
  timestamp_ms: number;
  state: string;
  confidence: number;
  latency_ms: number;
}

interface TurnTimelineProps {
  configId: string;
  label: string;
  results: TurnResultPoint[];
  totalDurationMs: number;
  viewport: Viewport;
  width?: number;
  height?: number;
  className?: string;
  hoverTimeMs?: number | null;
  onHoverTimeChange?: (timeMs: number | null) => void;
  recording?: boolean;
  playheadMs?: number | null;
}

const STATE_COLORS: Record<string, string> = {
  finished: "#22c55e",
  unfinished: "#6b7280",
  wait: "#f59e0b",
};

export function TurnTimeline({
  configId: _configId,
  label,
  results,
  totalDurationMs,
  viewport,
  width = 800,
  height = 32,
  className,
  hoverTimeMs,
  onHoverTimeChange,
  recording = false,
  playheadMs,
}: TurnTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const effectiveViewport = recording
    ? {
        viewStartMs: totalDurationMs - viewport.viewDurationMs,
        viewDurationMs: viewport.viewDurationMs,
      }
    : viewport;

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onHoverTimeChange) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const timeMs = pixelToTime(x, width, effectiveViewport);
      onHoverTimeChange(Math.max(0, Math.min(totalDurationMs, timeMs)));
    },
    [onHoverTimeChange, totalDurationMs, width, effectiveViewport]
  );

  const handleMouseLeave = useCallback(() => {
    onHoverTimeChange?.(null);
  }, [onHoverTimeChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    // Background for recorded area
    if (totalDurationMs > 0) {
      const x1 = Math.max(0, timeToPixel(0, width, effectiveViewport));
      const x2 = Math.min(width, timeToPixel(totalDurationMs, width, effectiveViewport));
      if (x2 > x1) {
        ctx.fillStyle = "#f3f4f6";
        ctx.fillRect(x1, 0, x2 - x1, height);
      }
    }

    if (results.length === 0) {
      // Hover and playhead still drawn below
    } else {
      const viewEndMs = effectiveViewport.viewStartMs + effectiveViewport.viewDurationMs;

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.timestamp_ms < effectiveViewport.viewStartMs - 1000) continue;
        if (result.timestamp_ms > viewEndMs + 1000) continue;

        // Segment spans from previous prediction to this one
        const segStartMs = i === 0 ? 0 : results[i - 1].timestamp_ms;
        const segEndMs = result.timestamp_ms;

        const x1 = timeToPixel(segStartMs, width, effectiveViewport);
        const x2 = timeToPixel(segEndMs, width, effectiveViewport);
        const segWidth = Math.max(1, x2 - x1);
        const barHeight = Math.max(4, height * result.confidence);

        const color = STATE_COLORS[result.state] ?? "#6b7280";
        ctx.globalAlpha = result.state === "finished" ? 0.85 : 0.5;
        ctx.fillStyle = color;
        ctx.fillRect(Math.max(0, x1), height - barHeight, segWidth, barHeight);
      }

      ctx.globalAlpha = 1;
    }

    // Hover line
    if (hoverTimeMs != null) {
      const hx = timeToPixel(hoverTimeMs, width, effectiveViewport);
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, height);
      ctx.stroke();
    }

    // Playhead
    if (playheadMs != null) {
      const px = timeToPixel(playheadMs, width, effectiveViewport);
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
    }
  }, [results, totalDurationMs, effectiveViewport, width, height, hoverTimeMs, playheadMs]);

  // Find hovered prediction for tooltip
  const hoveredResult =
    hoverTimeMs != null
      ? [...results].reverse().find((r) => r.timestamp_ms <= hoverTimeMs)
      : null;

  return (
    <div className="flex items-center gap-2">
      {/* Label */}
      <div className="flex-none w-32 text-xs text-muted-foreground truncate text-right pr-1">
        {label}
        <div className="flex gap-1 justify-end mt-0.5">
          <span className="inline-block w-2 h-2 rounded-sm" style={{ background: STATE_COLORS.finished }} />
          <span className="inline-block w-2 h-2 rounded-sm" style={{ background: STATE_COLORS.unfinished }} />
          <span className="inline-block w-2 h-2 rounded-sm" style={{ background: STATE_COLORS.wait }} />
        </div>
      </div>

      {/* Canvas */}
      <div
        className="relative flex-1"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <canvas
          ref={canvasRef}
          style={{ width, height, display: "block" }}
          className={className}
        />
        {/* Hover tooltip */}
        {hoveredResult && (
          <div className="absolute top-0 left-0 pointer-events-none text-xs bg-black/70 text-white px-1.5 py-0.5 rounded ml-1 mt-0.5 whitespace-nowrap">
            {hoveredResult.state} · {(hoveredResult.confidence * 100).toFixed(0)}% · {hoveredResult.latency_ms}ms
          </div>
        )}
      </div>
    </div>
  );
}
