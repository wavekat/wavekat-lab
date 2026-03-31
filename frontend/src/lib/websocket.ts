export interface AudioDevice {
  index: number;
  name: string;
}

export interface PreprocessorConfig {
  high_pass_hz?: number | null;
  denoise?: boolean;
  normalize_dbfs?: number | null;
}

export interface VadConfig {
  id: string;
  label: string;
  backend: string;
  params: Record<string, unknown>;
  preprocessing?: PreprocessorConfig;
}

export interface TurnConfig {
  id: string;
  label: string;
  backend: string;
  params: Record<string, unknown>;
}

export interface PipelineConfig {
  id: string;
  label: string;
  vad_config_id: string;
  turn_config_id: string;
  speech_end_threshold: number;
  speech_start_threshold: number;
  min_silence_ms: number;
  reset_mode: "hard" | "soft";
}

export interface PipelineResultPoint {
  timestamp_ms: number;
  event: string;
  turn_state?: string;
  turn_confidence?: number;
  turn_latency_ms?: number;
}

export interface ParamInfo {
  name: string;
  description: string;
  param_type: { type: "Select"; options: { value: string; label: string }[] } | { type: "Float"; options: { min: number; max: number } } | { type: "Int"; options: { min: number; max: number } };
  default: unknown;
}

// Server -> Client messages
export type ServerMessage =
  | { type: "devices"; devices: AudioDevice[] }
  | { type: "backends"; backends: Record<string, ParamInfo[]>; preprocessing_params: ParamInfo[] }
  | { type: "recording_started"; sample_rate: number; spectrum_bins: number }
  | { type: "audio"; timestamp_ms: number; samples: number[] }
  | { type: "spectrum"; timestamp_ms: number; magnitudes: number[] }
  | { type: "preprocessed_audio"; config_id: string; timestamp_ms: number; samples: number[] }
  | { type: "preprocessed_spectrum"; config_id: string; timestamp_ms: number; magnitudes: number[] }
  | { type: "vad"; config_id: string; timestamp_ms: number; probability: number; inference_us: number; stage_times: Array<{ name: string; us: number }>; frame_duration_ms: number }
  | { type: "turn_backends"; backends: Record<string, ParamInfo[]> }
  | { type: "turn"; config_id: string; timestamp_ms: number; state: string; confidence: number; latency_ms: number; stage_times: Array<{ name: string; us: number }> }
  | { type: "pipeline"; config_id: string; timestamp_ms: number; event: string; turn_state?: string; turn_confidence?: number; turn_latency_ms?: number }
  | { type: "done" }
  | { type: "error"; message: string };

// Client -> Server messages
export type ClientMessage =
  | { type: "list_devices" }
  | { type: "list_backends" }
  | { type: "start_recording"; device_index: number; max_duration_secs?: number }
  | { type: "stop_recording" }
  | { type: "load_file"; path: string; channel?: "mixed" | "left" | "right" }
  | { type: "set_configs"; configs: VadConfig[] }
  | { type: "set_spectrum_bins"; bins: number }
  | { type: "list_turn_backends" }
  | { type: "set_turn_configs"; configs: TurnConfig[] }
  | { type: "set_pipeline_configs"; configs: PipelineConfig[] };

export type MessageHandler = (msg: ServerMessage) => void;

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";
export type ConnectionHandler = (state: ConnectionState) => void;

export interface LogEntry {
  timestamp: Date;
  direction: "send" | "recv" | "system";
  summary: string;
  detail?: string;
}

export type LogHandler = (entry: LogEntry) => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10000;
const LOG_BATCH_INTERVAL_MS = 1000;

interface StreamBatch {
  audioFrames: number;
  audioMinMs: number;
  audioMaxMs: number;
  spectrumFrames: number;
  preprocessedAudioFrames: Map<string, number>;
  preprocessedSpectrumFrames: Map<string, number>;
  vad: Map<string, { count: number; minP: number; maxP: number; sumP: number }>;
}

export class VadLabSocket {
  private ws: WebSocket | null = null;
  private handlers: Set<MessageHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();
  private logHandlers: Set<LogHandler> = new Set();
  private url: string;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private streamBatch: StreamBatch | null = null;
  private batchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(url?: string) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.url = url ?? `${protocol}//${window.location.host}/ws`;
  }

  connect(): Promise<void> {
    this.intentionalClose = false;
    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.emitConnection("connecting");
      this.emitLog("system", "Connecting...");
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectAttempt = 0;
        this.emitConnection("connected");
        this.emitLog("system", "Connected");
        resolve();
      };

      this.ws.onerror = () => {
        // onclose will fire after this, which handles reconnect
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          this.logServerMessage(msg);
          for (const handler of this.handlers) {
            handler(msg);
          }
        } catch (e) {
          this.emitLog("system", `Parse error: ${e}`);
        }
      };

      this.ws.onclose = () => {
        this.ws = null;
        if (this.intentionalClose) {
          this.emitConnection("disconnected");
          this.emitLog("system", "Disconnected");
          return;
        }
        // First connect attempt failed
        if (this.reconnectAttempt === 0 && !this.connected) {
          this.emitConnection("disconnected");
          reject(new Error("WebSocket connection failed"));
        }
        this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect() {
    if (this.intentionalClose) return;

    this.reconnectAttempt++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt - 1), RECONNECT_MAX_MS);
    this.emitConnection("reconnecting");
    this.emitLog("system", `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose) return;

      this.doConnect().catch(() => {
        // onclose handler will schedule next retry
      });
    }, delay);
  }

  disconnect() {
    this.intentionalClose = true;
    this.flushBatch();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.emitConnection("disconnected");
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(msg);
      this.ws.send(data);
      this.emitLog("send", summarizeClient(msg), data);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onConnection(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  onLog(handler: LogHandler): () => void {
    this.logHandlers.add(handler);
    return () => this.logHandlers.delete(handler);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private emitConnection(state: ConnectionState) {
    for (const handler of this.connectionHandlers) {
      handler(state);
    }
  }

  private emitLog(direction: LogEntry["direction"], summary: string, detail?: string) {
    const entry: LogEntry = { timestamp: new Date(), direction, summary, detail };
    for (const handler of this.logHandlers) {
      handler(entry);
    }
  }

  private logServerMessage(msg: ServerMessage) {
    if (msg.type === "audio" || msg.type === "vad" || msg.type === "spectrum" ||
        msg.type === "preprocessed_audio" || msg.type === "preprocessed_spectrum") {
      this.addToBatch(msg);
    } else {
      // Flush any pending batch before logging a non-streaming message
      this.flushBatch();
      this.emitLog("recv", summarizeServer(msg));
    }
  }

  private addToBatch(msg: ServerMessage & { type: "audio" | "vad" | "spectrum" | "preprocessed_audio" | "preprocessed_spectrum" }) {
    if (!this.streamBatch) {
      this.streamBatch = {
        audioFrames: 0,
        audioMinMs: Infinity,
        audioMaxMs: -Infinity,
        spectrumFrames: 0,
        preprocessedAudioFrames: new Map(),
        preprocessedSpectrumFrames: new Map(),
        vad: new Map(),
      };
      this.startBatchTimer();
    }

    const batch = this.streamBatch;
    if (msg.type === "audio") {
      batch.audioFrames++;
      batch.audioMinMs = Math.min(batch.audioMinMs, msg.timestamp_ms);
      batch.audioMaxMs = Math.max(batch.audioMaxMs, msg.timestamp_ms);
    } else if (msg.type === "spectrum") {
      batch.spectrumFrames++;
    } else if (msg.type === "preprocessed_audio") {
      batch.preprocessedAudioFrames.set(
        msg.config_id,
        (batch.preprocessedAudioFrames.get(msg.config_id) ?? 0) + 1
      );
    } else if (msg.type === "preprocessed_spectrum") {
      batch.preprocessedSpectrumFrames.set(
        msg.config_id,
        (batch.preprocessedSpectrumFrames.get(msg.config_id) ?? 0) + 1
      );
    } else {
      const existing = batch.vad.get(msg.config_id);
      if (existing) {
        existing.count++;
        existing.minP = Math.min(existing.minP, msg.probability);
        existing.maxP = Math.max(existing.maxP, msg.probability);
        existing.sumP += msg.probability;
      } else {
        batch.vad.set(msg.config_id, {
          count: 1,
          minP: msg.probability,
          maxP: msg.probability,
          sumP: msg.probability,
        });
      }
    }
  }

  private startBatchTimer() {
    if (this.batchTimer) return;
    this.batchTimer = setInterval(() => this.flushBatch(), LOG_BATCH_INTERVAL_MS);
  }

  private stopBatchTimer() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private flushBatch() {
    const batch = this.streamBatch;
    if (!batch) {
      this.stopBatchTimer();
      return;
    }
    this.streamBatch = null;
    this.stopBatchTimer();

    const parts: string[] = [];

    if (batch.audioFrames > 0) {
      parts.push(
        `audio: ${batch.audioFrames} frames (${batch.audioMinMs.toFixed(0)}-${batch.audioMaxMs.toFixed(0)}ms)`
      );
    }

    if (batch.spectrumFrames > 0) {
      parts.push(`spectrum: ${batch.spectrumFrames} frames`);
    }

    // Summarize preprocessed frames per config
    const preprocessedConfigs = new Set([
      ...batch.preprocessedAudioFrames.keys(),
      ...batch.preprocessedSpectrumFrames.keys(),
    ]);
    for (const configId of preprocessedConfigs) {
      const audioCount = batch.preprocessedAudioFrames.get(configId) ?? 0;
      const spectrumCount = batch.preprocessedSpectrumFrames.get(configId) ?? 0;
      if (audioCount > 0 || spectrumCount > 0) {
        parts.push(`preprocessed [${configId}]: ${audioCount} audio, ${spectrumCount} spectrum`);
      }
    }

    for (const [configId, stats] of batch.vad) {
      const avg = stats.sumP / stats.count;
      if (stats.minP === stats.maxP) {
        parts.push(`vad [${configId}]: ${stats.count}x p=${avg.toFixed(2)}`);
      } else {
        parts.push(
          `vad [${configId}]: ${stats.count}x p=${stats.minP.toFixed(2)}-${stats.maxP.toFixed(2)} avg=${avg.toFixed(2)}`
        );
      }
    }

    if (parts.length > 0) {
      this.emitLog("recv", parts.join(" | "));
    }
  }
}

function summarizeServer(msg: ServerMessage): string {
  switch (msg.type) {
    case "devices": return `devices (${msg.devices.length})`;
    case "backends": return `backends (${Object.keys(msg.backends).length}, ${msg.preprocessing_params.length} preprocessing)`;
    case "recording_started": return `recording_started (${msg.sample_rate} Hz, ${msg.spectrum_bins} bins)`;
    case "audio": return `audio t=${msg.timestamp_ms.toFixed(0)}ms`;
    case "spectrum": return `spectrum t=${msg.timestamp_ms.toFixed(0)}ms`;
    case "preprocessed_audio": return `preprocessed_audio [${msg.config_id}] t=${msg.timestamp_ms.toFixed(0)}ms`;
    case "preprocessed_spectrum": return `preprocessed_spectrum [${msg.config_id}] t=${msg.timestamp_ms.toFixed(0)}ms`;
    case "vad": return `vad [${msg.config_id}] t=${msg.timestamp_ms.toFixed(0)}ms p=${msg.probability.toFixed(2)}`;
    case "turn_backends": return `turn_backends (${Object.keys(msg.backends).length})`;
    case "turn": return `turn [${msg.config_id}] t=${msg.timestamp_ms.toFixed(0)}ms state=${msg.state} conf=${msg.confidence.toFixed(2)} lat=${msg.latency_ms}ms`;
    case "pipeline": return `pipeline [${msg.config_id}] t=${msg.timestamp_ms.toFixed(0)}ms ${msg.event}${msg.turn_state ? ` ${msg.turn_state} ${((msg.turn_confidence ?? 0) * 100).toFixed(0)}%` : ""}`;
    case "done": return "done";
    case "error": return `error: ${msg.message}`;
  }
}

function summarizeClient(msg: ClientMessage): string {
  switch (msg.type) {
    case "list_devices": return "list_devices";
    case "list_backends": return "list_backends";
    case "start_recording": return `start_recording (device=${msg.device_index})`;
    case "stop_recording": return "stop_recording";
    case "load_file": return `load_file (${msg.path})`;
    case "set_configs": return `set_configs (${msg.configs.length})`;
    case "set_spectrum_bins": return `set_spectrum_bins (${msg.bins})`;
    case "list_turn_backends": return "list_turn_backends";
    case "set_turn_configs": return `set_turn_configs (${msg.configs.length})`;
    case "set_pipeline_configs": return `set_pipeline_configs (${msg.configs.length})`;
  }
}
