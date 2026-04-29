import { useRef, useEffect, useMemo } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { type Viewport, timeToPixel } from "@/lib/viewport";
import { useTimelineDrag } from "@/lib/useTimelineDrag";

interface VadConfig {
  backend: string;
  params: Record<string, unknown>;
  preprocessing?: {
    high_pass_hz?: number | null;
    denoise?: boolean;
    normalize_dbfs?: number | null;
  };
}

interface VadTimelineProps {
  label: string;
  /** Optional config to display backend and parameter info */
  config?: VadConfig;
  results: Array<{ timestamp_ms: number; probability: number }>;
  /** Real-Time Factor (processing_time / audio_duration). Lower is better. */
  rtf?: number | null;
  /** Per-stage average timing breakdown in µs/frame. */
  stageAvgs?: Array<{ name: string; us: number }>;
  /** Frame duration in milliseconds (from backend capabilities). */
  frameDurationMs?: number;
  totalDurationMs: number;
  viewport: Viewport;
  width?: number;
  height?: number;
  color?: string;
  className?: string;
  hoverTimeMs?: number | null;
  onHoverTimeChange?: (timeMs: number | null) => void;
  onViewportChange?: (v: Viewport) => void;
  /** When true, "now" is anchored to right edge */
  recording?: boolean;
  /** Current playhead position in milliseconds (for playback) */
  playheadMs?: number | null;
}

/** Build a short summary string for the config */
function formatConfigSummary(config: VadConfig): string {
  const parts: string[] = [config.backend];

  // Add key backend params
  for (const [key, value] of Object.entries(config.params)) {
    if (value != null && value !== "") {
      parts.push(`${key}:${String(value)}`);
    }
  }

  // Add preprocessing if enabled
  const pp = config.preprocessing;
  if (pp) {
    if (pp.high_pass_hz != null) parts.push(`hp:${pp.high_pass_hz}Hz`);
    if (pp.denoise) parts.push("denoise");
    if (pp.normalize_dbfs != null) parts.push(`norm:${pp.normalize_dbfs}dB`);
  }

  return parts.join(" | ");
}

export function VadTimeline({
  label,
  config,
  results,
  rtf,
  stageAvgs,
  frameDurationMs,
  totalDurationMs,
  viewport,
  width = 800,
  height = 40,
  color = "#22c55e",
  className,
  hoverTimeMs,
  onHoverTimeChange,
  onViewportChange,
  recording = false,
  playheadMs,
}: VadTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // During recording, anchor "now" to the right edge
  const effectiveViewport = useMemo(
    () =>
      recording
        ? {
            viewStartMs: totalDurationMs - viewport.viewDurationMs,
            viewDurationMs: viewport.viewDurationMs,
          }
        : viewport,
    [recording, totalDurationMs, viewport],
  );

  const { handleMouseDown, handleMouseMove, handleMouseUp, handleMouseLeave, cursor } =
    useTimelineDrag({ viewport, effectiveViewport, width, totalDurationMs, recording, onViewportChange, onHoverTimeChange });

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
        ctx.fillStyle = "#f3f4f6"; // light grey
        ctx.fillRect(recordedStartX, 0, recordedEndX - recordedStartX, height);
      }
    }

    if (results.length === 0) return;

    // Filter to visible results and render them
    const viewEndMs = effectiveViewport.viewStartMs + effectiveViewport.viewDurationMs;

    // Draw speech probability as filled bars
    // Results are sorted by timestamp, so we can calculate width based on next result
    const thresholdVal = config?.params?.threshold;
    const hasThreshold = typeof thresholdVal === "number" && thresholdVal > 0 && thresholdVal < 1;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      // Skip results outside viewport (effectiveViewport.viewStartMs can be negative)
      if (result.timestamp_ms < effectiveViewport.viewStartMs - 100) continue;
      if (result.timestamp_ms > viewEndMs + 100) continue;

      const x = timeToPixel(result.timestamp_ms, width, effectiveViewport);

      // Calculate bar width based on the time to the next result
      // This ensures bars fill the space without gaps
      let frameDurationMs: number;
      if (i < results.length - 1) {
        frameDurationMs = results[i + 1].timestamp_ms - result.timestamp_ms;
      } else if (i > 0) {
        // For the last result, use the previous interval
        frameDurationMs = result.timestamp_ms - results[i - 1].timestamp_ms;
      } else {
        // Single result, use a default
        frameDurationMs = 30;
      }

      const barWidth = Math.max(1, (frameDurationMs / effectiveViewport.viewDurationMs) * width);
      const barHeight = result.probability * height;
      const aboveThreshold = hasThreshold && result.probability >= thresholdVal;

      ctx.fillStyle = hasThreshold && !aboveThreshold ? "#9ca3af" : color;
      ctx.globalAlpha = aboveThreshold ? 0.5 + result.probability * 0.5 : 0.3 + result.probability * 0.4;
      ctx.fillRect(x, height - barHeight, barWidth, barHeight);
    }

    ctx.globalAlpha = 1;

    // Draw threshold line if present
    const threshold = config?.params?.threshold;
    if (typeof threshold === "number" && threshold > 0 && threshold < 1) {
      const y = height - threshold * height;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Draw crosshair
    if (hoverTimeMs != null) {
      const x = timeToPixel(hoverTimeMs, width, effectiveViewport);

      if (x >= 0 && x <= width) {
        // Vertical line
        ctx.strokeStyle = "#f97316";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();

        // Find probability at hover time
        const closestResult = results.reduce<{
          timestamp_ms: number;
          probability: number;
        } | null>((closest, r) => {
          if (!closest) return r;
          return Math.abs(r.timestamp_ms - hoverTimeMs) <
            Math.abs(closest.timestamp_ms - hoverTimeMs)
            ? r
            : closest;
        }, null);

        if (
          closestResult &&
          Math.abs(closestResult.timestamp_ms - hoverTimeMs) < 100
        ) {
          const probStr = (closestResult.probability * 100).toFixed(0) + "%";
          ctx.font = "10px monospace";
          ctx.fillStyle = "#f97316";
          const textWidth = ctx.measureText(probStr).width;
          const labelX =
            x + 4 > width - textWidth - 4 ? x - textWidth - 4 : x + 4;
          ctx.fillText(probStr, labelX, height / 2 + 4);
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

        // Show probability at playhead position
        const closestResult = results.reduce<{
          timestamp_ms: number;
          probability: number;
        } | null>((closest, r) => {
          if (!closest) return r;
          return Math.abs(r.timestamp_ms - playheadMs) <
            Math.abs(closest.timestamp_ms - playheadMs)
            ? r
            : closest;
        }, null);

        if (
          closestResult &&
          Math.abs(closestResult.timestamp_ms - playheadMs) < 100
        ) {
          const probStr = (closestResult.probability * 100).toFixed(0) + "%";
          ctx.font = "10px monospace";
          ctx.fillStyle = "#3b82f6";
          const textWidth = ctx.measureText(probStr).width;
          const labelX =
            x + 4 > width - textWidth - 4 ? x - textWidth - 4 : x + 4;
          ctx.fillText(probStr, labelX, height / 2 + 4);
        }
      }
    }
  }, [results, width, height, color, config, hoverTimeMs, playheadMs, totalDurationMs, effectiveViewport]);

  return (
    <div className={`${className} mb-4`}>
      <div className="flex items-baseline gap-2 mb-1">
        <div className="flex flex-col">
          <span className="text-xs font-medium font-mono">{label}</span>
          {config && (
            <span className="text-xs text-muted-foreground font-mono">
              {formatConfigSummary(config)}
            </span>
          )}
        </div>
        {rtf != null && (
          <div className="text-xs text-muted-foreground font-mono ml-auto flex items-baseline gap-1">
            <div className="flex flex-col items-end">
              <span className="tabular-nums">RTF {rtf.toFixed(4)}</span>
              {stageAvgs && stageAvgs.length > 0 && (
                <span className="opacity-70">({stageAvgs.map((s) =>
                  `${s.name}: ${s.us < 10 ? s.us.toFixed(1) : Math.round(s.us)}µs`
                ).join(" → ")})</span>
              )}
            </div>
            {frameDurationMs != null && frameDurationMs > 0 && stageAvgs && stageAvgs.length > 0 && (() => {
              const totalUs = stageAvgs.reduce((sum, s) => sum + s.us, 0);
              const frameDurationUs = frameDurationMs * 1000;
              return (
                <Tooltip>
                  <TooltipTrigger className="text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                    <Info className="size-3" />
                  </TooltipTrigger>
                  <TooltipContent side="left" align="start" className="block max-w-none font-mono text-[11px] leading-relaxed py-2">
                    <div className="whitespace-nowrap opacity-70 mb-1">RTF = processing time / audio duration</div>
                    <table className="border-spacing-x-2 border-separate">
                      <tbody>
                        <tr>
                          <td className="text-right opacity-70">frame</td>
                          <td className="whitespace-nowrap">{frameDurationMs}ms ({frameDurationUs.toLocaleString()}µs)</td>
                        </tr>
                        {stageAvgs.map((s) => (
                          <tr key={s.name}>
                            <td className="text-right opacity-70">{s.name}</td>
                            <td>{s.us < 10 ? s.us.toFixed(1) : Math.round(s.us)}µs</td>
                          </tr>
                        ))}
                        <tr>
                          <td className="text-right font-semibold pt-0.5 border-t border-background/20">total</td>
                          <td className="whitespace-nowrap pt-0.5 border-t border-background/20">{Math.round(totalUs)}µs / {frameDurationUs.toLocaleString()}µs ≈ <span className="font-semibold">{(totalUs / frameDurationUs).toFixed(4)}</span></td>
                        </tr>
                      </tbody>
                    </table>
                    <div className="mt-1 opacity-70">Lower is better. RTF &lt; 1 = faster than real-time.</div>
                  </TooltipContent>
                </Tooltip>
              );
            })()}
          </div>
        )}
      </div>
      <div
        className="border rounded"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        style={{ width, height, cursor }}
      >
        <canvas ref={canvasRef} style={{ width, height }} />
      </div>
    </div>
  );
}
