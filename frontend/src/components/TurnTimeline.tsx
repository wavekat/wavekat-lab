import { useRef, useEffect, useCallback, useMemo } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { type Viewport, pixelToTime, timeToPixel } from "@/lib/viewport";
import { type TurnConfig } from "@/lib/websocket";

export interface TurnResultPoint {
  timestamp_ms: number;
  state: string;
  confidence: number;
  latency_ms: number;
}

interface TurnTimelineProps {
  configId: string;
  label: string;
  config?: TurnConfig;
  results: TurnResultPoint[];
  /** Per-stage average timing breakdown in µs/prediction. */
  stageAvgs?: Array<{ name: string; us: number }>;
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

function formatConfigSummary(config: TurnConfig): string {
  const parts: string[] = [config.backend];
  for (const [key, value] of Object.entries(config.params)) {
    if (value != null && value !== "") {
      parts.push(`${key}:${String(value)}`);
    }
  }
  return parts.join(" | ");
}

function formatTiming(us: number): string {
  if (us >= 1000) return `${(us / 1000).toFixed(1)}ms`;
  return `${us < 10 ? us.toFixed(1) : Math.round(us)}µs`;
}

export const STATE_COLORS: Record<string, string> = {
  finished: "#22c55e",
  unfinished: "#6b7280",
  wait: "#f59e0b",
};

export function TurnTimeline({
  configId: _configId,
  label,
  config,
  results,
  stageAvgs,
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

        // Segment spans from previous prediction to this one.
        // Skip the first result to avoid backfilling before detection started.
        const segStartMs = i === 0 ? result.timestamp_ms : results[i - 1].timestamp_ms;
        const segEndMs = result.timestamp_ms;
        if (segStartMs >= segEndMs) continue;

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
  const hoveredIndex =
    hoverTimeMs != null
      ? results.reduce((best, r, i) => (r.timestamp_ms <= hoverTimeMs ? i : best), -1)
      : -1;
  const hoveredResult = hoveredIndex >= 0 ? results[hoveredIndex] : null;

  // Compute average RTF from all results
  const rtfStats = useMemo(() => {
    if (results.length < 2) return null;
    let totalLatency = 0;
    let totalInterval = 0;
    let count = 0;
    for (let i = 1; i < results.length; i++) {
      const interval = results[i].timestamp_ms - results[i - 1].timestamp_ms;
      if (interval > 0) {
        totalLatency += results[i].latency_ms;
        totalInterval += interval;
        count++;
      }
    }
    if (count === 0) return null;
    const avgLatency = totalLatency / count;
    const avgInterval = totalInterval / count;
    return { rtf: avgLatency / avgInterval, avgLatencyMs: avgLatency, avgIntervalMs: avgInterval };
  }, [results]);

  return (
    <div className="mb-4">
      {/* Label row */}
      <div className="flex items-baseline gap-2 mb-1">
        <div className="flex flex-col">
          <span className="text-xs font-medium font-mono">{label}</span>
          {config && (
            <span className="text-xs text-muted-foreground font-mono">
              {formatConfigSummary(config)}
            </span>
          )}
        </div>
        <div className="flex gap-4 items-center ml-auto">
          {rtfStats != null && (
            <div className="text-xs text-muted-foreground font-mono flex items-baseline gap-1">
              <div className="flex flex-col items-end">
                <span className="tabular-nums">RTF {rtfStats.rtf.toFixed(4)}</span>
                {stageAvgs && stageAvgs.length > 0 && (
                  <span className="opacity-70">({stageAvgs.map((s) =>
                    `${s.name}: ${formatTiming(s.us)}`
                  ).join(" → ")})</span>
                )}
              </div>
              <Tooltip>
                <TooltipTrigger className="text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                  <Info className="size-3" />
                </TooltipTrigger>
                <TooltipContent side="left" align="start" className="block max-w-none font-mono text-[11px] leading-relaxed py-2">
                  <div className="whitespace-nowrap opacity-70 mb-1">RTF = avg latency / avg predict interval</div>
                  <table className="border-spacing-x-2 border-separate">
                    <tbody>
                      <tr>
                        <td className="text-right opacity-70">avg interval</td>
                        <td className="whitespace-nowrap">{rtfStats.avgIntervalMs.toFixed(1)}ms ({(rtfStats.avgIntervalMs * 1000).toLocaleString()}µs)</td>
                      </tr>
                      {stageAvgs && stageAvgs.map((s) => (
                        <tr key={s.name}>
                          <td className="text-right opacity-70">{s.name}</td>
                          <td>{formatTiming(s.us)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td className="text-right font-semibold pt-0.5 border-t border-background/20">total</td>
                        <td className="whitespace-nowrap pt-0.5 border-t border-background/20">
                          {rtfStats.avgLatencyMs.toFixed(1)}ms / {rtfStats.avgIntervalMs.toFixed(1)}ms ≈ <span className="font-semibold">{rtfStats.rtf.toFixed(4)}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <div className="mt-1 opacity-70">Lower is better. RTF &lt; 1 = faster than real-time.</div>
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div
        className={`relative ${className ?? ""}`}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ width, height }}
      >
        <canvas
          ref={canvasRef}
          style={{ width, height, display: "block" }}
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
