import { useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AsrConfig } from "@/lib/websocket";

export interface AsrTranscriptFinal {
  ts_ms: number;
  end_ms: number;
  text: string;
  confidence: number;
}

export interface AsrTranscriptState {
  ready: boolean;
  finals: AsrTranscriptFinal[];
  partial: string | null;
  warning: string | null;
}

interface AsrTranscriptProps {
  configs: AsrConfig[];
  states: Record<string, AsrTranscriptState>;
}

function formatMs(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function AsrTranscript({ configs, states }: AsrTranscriptProps) {
  if (configs.length === 0) return null;

  return (
    <div className="space-y-3">
      {configs.map((config) => (
        <AsrTranscriptCard
          key={config.id}
          config={config}
          state={states[config.id]}
        />
      ))}
    </div>
  );
}

interface AsrTranscriptCardProps {
  config: AsrConfig;
  state: AsrTranscriptState | undefined;
}

function AsrTranscriptCard({ config, state }: AsrTranscriptCardProps) {
  const ready = state?.ready ?? false;
  const finals = useMemo(() => state?.finals ?? [], [state?.finals]);
  const partial = state?.partial ?? null;
  const warning = state?.warning ?? null;
  const preset =
    typeof config.params.preset === "string" ? config.params.preset : "—";

  const stats = useMemo(() => {
    if (finals.length === 0) return null;
    const lastFinal = finals[finals.length - 1];
    const avgDuration =
      finals.reduce((sum, f) => sum + (f.end_ms - f.ts_ms), 0) / finals.length;
    return {
      count: finals.length,
      lastConfidence: lastFinal.confidence,
      avgDurationMs: avgDuration,
    };
  }, [finals]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoScrollRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [finals.length, partial]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    autoScrollRef.current = atBottom;
  };

  const copyAll = () => {
    const text = finals.map((f) => f.text).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">
            ASR: {config.label}{" "}
            <span className="text-muted-foreground text-xs">
              · {config.backend} · {preset}
            </span>
          </CardTitle>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-xs"
            onClick={copyAll}
            disabled={finals.length === 0}
          >
            Copy all
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-40 overflow-y-auto rounded border bg-muted/30 px-2 py-1 font-mono text-xs"
        >
          {!ready && !warning && (
            <div className="text-muted-foreground italic">loading model…</div>
          )}
          {warning && (
            <div className="text-destructive">⚠ {warning}</div>
          )}
          {finals.map((f, i) => (
            <div key={i}>
              <span className="text-muted-foreground">
                [{formatMs(f.ts_ms)}–{formatMs(f.end_ms)}]
              </span>{" "}
              {f.text}
            </div>
          ))}
          {partial && (
            <div className="text-muted-foreground italic">
              partial: {partial}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {stats ? (
            <span>
              conf {stats.lastConfidence.toFixed(2)} · {stats.count} finals · avg{" "}
              {(stats.avgDurationMs / 1000).toFixed(1)}s/segment
            </span>
          ) : (
            <span>{ready ? "waiting for speech…" : "—"}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
