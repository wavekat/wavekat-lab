import { useRef, useEffect, useMemo } from "react";
import { type Viewport, timeToPixel } from "@/lib/viewport";
import { useTimelineDrag } from "@/lib/useTimelineDrag";
import { STATE_COLORS } from "@/lib/turnColors";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import type { PipelineResultPoint, PipelineConfig } from "@/lib/websocket";

interface SpeechSegment {
  startMs: number;
  endMs: number | null; // null = ongoing
  turnState?: string;
  turnConfidence?: number;
  turnLatencyMs?: number;
  audioDurationMs?: number;
}

interface PipelineTimelineProps {
  label: string;
  config?: PipelineConfig;
  /** Resolved name of the linked VAD config. */
  vadLabel?: string;
  /** Resolved name of the linked Turn config. */
  turnLabel?: string;
  results: PipelineResultPoint[];
  totalDurationMs: number;
  viewport: Viewport;
  width?: number;
  height?: number;
  className?: string;
  hoverTimeMs?: number | null;
  onHoverTimeChange?: (timeMs: number | null) => void;
  onViewportChange?: (v: Viewport) => void;
  recording?: boolean;
  playheadMs?: number | null;
}

function formatConfigSummary(config: PipelineConfig, vadLabel?: string, turnLabel?: string): string {
  const vad = vadLabel ?? config.vad_config_id;
  const turn = turnLabel ?? config.turn_config_id;
  const reset = config.reset_mode === "soft" ? "soft" : "hard";
  return `${vad} \u2192 ${turn} | start:${config.speech_start_threshold} end:${config.speech_end_threshold} silence:${config.min_silence_ms}ms reset:${reset}`;
}

export function PipelineTimeline({
  label,
  config,
  vadLabel,
  turnLabel,
  results,
  totalDurationMs,
  viewport,
  width = 800,
  height = 48,
  className,
  hoverTimeMs,
  onHoverTimeChange,
  onViewportChange,
  recording = false,
  playheadMs,
}: PipelineTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const effectiveViewport = useMemo(
    () =>
      recording
        ? {
            viewStartMs: totalDurationMs - viewport.viewDurationMs,
            viewDurationMs: viewport.viewDurationMs,
          }
        : viewport,
    [recording, totalDurationMs, viewport]
  );

  const { handleMouseDown, handleMouseMove, handleMouseUp, handleMouseLeave, cursor } =
    useTimelineDrag({ viewport, effectiveViewport, width, totalDurationMs, recording, onViewportChange, onHoverTimeChange });

  // Build speech segments from flat event list
  const segments = useMemo(() => {
    const segs: SpeechSegment[] = [];
    let currentStart: number | null = null;

    for (const event of results) {
      if (event.event === "speech_start") {
        currentStart = event.timestamp_ms;
      } else if (event.event === "speech_end" && currentStart !== null) {
        segs.push({
          startMs: currentStart,
          endMs: event.timestamp_ms,
          turnState: event.turn_state,
          turnConfidence: event.turn_confidence,
          turnLatencyMs: event.turn_latency_ms,
          audioDurationMs: event.audio_duration_ms,
        });
        currentStart = null;
      }
    }

    // Ongoing speech
    if (currentStart !== null) {
      segs.push({ startMs: currentStart, endMs: null });
    }

    return segs;
  }, [results]);

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

    const bandY = height * 0.3;
    const bandHeight = height * 0.3;
    const dotRadius = 6;
    const dotY = bandY + bandHeight / 2;

    // Collect label info while drawing bands and dots
    const labelEntries: Array<{ x: number; text: string; color: string }> = [];

    for (const seg of segments) {
      const endMs = seg.endMs ?? totalDurationMs;
      const x1 = timeToPixel(seg.startMs, width, effectiveViewport);
      const x2 = timeToPixel(endMs, width, effectiveViewport);
      const segWidth = Math.max(2, x2 - x1);

      // Speech band
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = "#6b7280";
      ctx.fillRect(x1, bandY, segWidth, bandHeight);
      ctx.globalAlpha = 1;

      // Prediction dot at right edge (only for completed segments)
      if (seg.endMs != null && seg.turnState) {
        const dotX = x2;
        const color = STATE_COLORS[seg.turnState] ?? "#6b7280";

        // Dot
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;

        // Collect label for deferred layout
        const durMs = seg.endMs - seg.startMs;
        const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
        const dur = fmtMs(durMs);
        const conf = seg.turnConfidence != null ? `${(seg.turnConfidence * 100).toFixed(0)}%` : "";
        const lat = seg.turnLatencyMs != null ? `${seg.turnLatencyMs}ms` : "";
        // Only show buffer duration when it differs notably from segment duration
        const audioDur = seg.audioDurationMs != null && Math.abs(seg.audioDurationMs - durMs) > 200
          ? `[${fmtMs(seg.audioDurationMs)}]`
          : "";
        const labelText = [dur, conf, lat, audioDur].filter(Boolean).join(" ");
        labelEntries.push({ x: dotX, text: labelText, color });
      }
    }

    // Draw labels with collision avoidance – stagger between bottom and top
    ctx.font = "10px monospace";
    const labelYBottom = height - 2;
    const labelYTop = 10;
    const labelGap = 4;
    let lastRightBottom = -Infinity;
    let lastRightTop = -Infinity;

    for (const lbl of labelEntries) {
      const tw = ctx.measureText(lbl.text).width;
      const left = lbl.x - tw / 2;
      const right = lbl.x + tw / 2;

      let yPos: number;
      if (left > lastRightBottom + labelGap) {
        yPos = labelYBottom;
        lastRightBottom = right;
      } else if (left > lastRightTop + labelGap) {
        yPos = labelYTop;
        lastRightTop = right;
      } else {
        // Both levels congested – place on bottom anyway
        yPos = labelYBottom;
        lastRightBottom = right;
      }

      ctx.fillStyle = lbl.color;
      ctx.globalAlpha = 0.85;
      ctx.textAlign = "center";
      ctx.fillText(lbl.text, lbl.x, yPos);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "start";

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
  }, [segments, totalDurationMs, effectiveViewport, width, height, hoverTimeMs, playheadMs]);

  // RTF stats across completed segments
  const rtfStats = useMemo(() => {
    const done = segments.filter((s) => s.endMs != null && s.turnLatencyMs != null);
    if (done.length === 0) return null;
    const totalAudioMs = done.reduce((sum, s) => sum + (s.endMs! - s.startMs), 0);
    const totalLatencyMs = done.reduce((sum, s) => sum + s.turnLatencyMs!, 0);
    if (totalAudioMs <= 0) return null;
    const avgAudioMs = totalAudioMs / done.length;
    const avgLatencyMs = totalLatencyMs / done.length;
    return { rtf: totalLatencyMs / totalAudioMs, avgAudioMs, avgLatencyMs };
  }, [segments]);

  const completedCount = useMemo(() => segments.filter((s) => s.endMs != null).length, [segments]);

  // Find hovered segment for tooltip
  const hoveredSegment = useMemo(() => {
    if (hoverTimeMs == null) return null;
    return segments.find(
      (seg) =>
        hoverTimeMs >= seg.startMs &&
        hoverTimeMs <= (seg.endMs ?? totalDurationMs)
    ) ?? null;
  }, [hoverTimeMs, segments, totalDurationMs]);

  return (
    <div className="mb-4">
      {/* Label row */}
      <div className="flex items-baseline gap-2 mb-1">
        <div className="flex flex-col">
          <span className="text-xs font-medium font-mono">{label}</span>
          {config && (
            <span className="text-xs text-muted-foreground font-mono">
              {formatConfigSummary(config, vadLabel, turnLabel)}
            </span>
          )}
        </div>
        {rtfStats != null && (
          <div className="text-xs text-muted-foreground font-mono ml-auto flex items-baseline gap-1">
            <div className="flex flex-col items-end">
              <span className="tabular-nums">RTF {rtfStats.rtf.toFixed(4)}</span>
              <span className="opacity-70">{completedCount} segments</span>
            </div>
            <Tooltip>
              <TooltipTrigger className="text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                <Info className="size-3" />
              </TooltipTrigger>
              <TooltipContent side="left" align="start" className="block max-w-none font-mono text-[11px] leading-relaxed py-2">
                <div className="whitespace-nowrap opacity-70 mb-1">RTF = avg latency / avg audio duration</div>
                <table className="border-spacing-x-2 border-separate">
                  <tbody>
                    <tr>
                      <td className="text-right opacity-70">avg audio</td>
                      <td className="whitespace-nowrap">{rtfStats.avgAudioMs.toFixed(1)}ms</td>
                    </tr>
                    <tr>
                      <td className="text-right opacity-70">avg latency</td>
                      <td className="whitespace-nowrap">{rtfStats.avgLatencyMs.toFixed(1)}ms</td>
                    </tr>
                    <tr>
                      <td className="text-right font-semibold pt-0.5 border-t border-background/20">total</td>
                      <td className="whitespace-nowrap pt-0.5 border-t border-background/20">
                        {rtfStats.avgLatencyMs.toFixed(1)}ms / {rtfStats.avgAudioMs.toFixed(1)}ms ≈ <span className="font-semibold">{rtfStats.rtf.toFixed(4)}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="mt-1 opacity-70">Lower is better. RTF &lt; 1 = faster than real-time.</div>
              </TooltipContent>
            </Tooltip>
          </div>
        )}
        {rtfStats == null && (
          <div className="ml-auto text-xs text-muted-foreground font-mono">
            {completedCount} segments
          </div>
        )}
      </div>

      {/* Canvas */}
      <div
        className={`relative ${className ?? ""}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        style={{ width, height, cursor }}
      >
        <canvas
          ref={canvasRef}
          style={{ width, height, display: "block" }}
        />
        {/* Hover tooltip */}
        {hoveredSegment && hoveredSegment.endMs != null && hoveredSegment.turnState && (
          <div className="absolute top-0 left-0 pointer-events-none text-xs bg-black/70 text-white px-1.5 py-0.5 rounded ml-1 mt-0.5 whitespace-nowrap">
            {hoveredSegment.turnState} &middot; {((hoveredSegment.turnConfidence ?? 0) * 100).toFixed(0)}% &middot; {hoveredSegment.turnLatencyMs}ms &middot; {((hoveredSegment.endMs - hoveredSegment.startMs) / 1000).toFixed(1)}s
          </div>
        )}
      </div>
    </div>
  );
}
