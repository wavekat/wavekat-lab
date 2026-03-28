import type { LogEntry } from "@/lib/websocket";

interface LogPanelProps {
  logs: LogEntry[];
  maxHeight?: number;
}

const DIRECTION_STYLE: Record<LogEntry["direction"], string> = {
  send: "text-blue-400",
  recv: "text-green-400",
  system: "text-yellow-400",
};

const DIRECTION_LABEL: Record<LogEntry["direction"], string> = {
  send: ">>",
  recv: "<<",
  system: "--",
};

function formatTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

export function LogPanel({ logs, maxHeight = 200 }: LogPanelProps) {
  return (
    <div
      className="bg-zinc-950 text-zinc-300 font-mono text-xs rounded border border-zinc-800 overflow-auto"
      style={{ maxHeight }}
    >
      <div className="p-2 space-y-px">
        {logs.length === 0 && (
          <div className="text-zinc-600">No logs yet</div>
        )}
        {[...logs].reverse().map((entry, i) => (
          <div key={i} className="flex gap-2 leading-5">
            <span className="text-zinc-600 shrink-0">
              {formatTime(entry.timestamp)}
            </span>
            <span className={`shrink-0 ${DIRECTION_STYLE[entry.direction]}`}>
              {DIRECTION_LABEL[entry.direction]}
            </span>
            <span className="break-all">{entry.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
