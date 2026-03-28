import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Waveform } from "@/components/Waveform";
import { VadTimeline } from "@/components/VadTimeline";
import { FrequencySpectrum } from "@/components/FrequencySpectrum";
import { ConfigPanel } from "@/components/ConfigPanel";
import { LogPanel } from "@/components/LogPanel";
import { ZoomControls } from "@/components/ZoomControls";
import { TurnTimeline, type TurnResultPoint, STATE_COLORS as TURN_STATE_COLORS } from "@/components/TurnTimeline";
import { TurnConfigPanel } from "@/components/TurnConfigPanel";
import {
  type Viewport,
  createDefaultViewport,
  calculateViewDuration,
} from "@/lib/viewport";
import { useAudioPlayback } from "@/lib/useAudioPlayback";
import {
  VadLabSocket,
  type AudioDevice,
  type VadConfig,
  type TurnConfig,
  type ParamInfo,
  type ServerMessage,
  type ConnectionState,
  type LogEntry,
} from "@/lib/websocket";

const COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
const MAX_LOG_ENTRIES = 500;

function downloadWav(samples: number[], sampleRate: number, filename: string) {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // WAV header
  writeString(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // subchunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, numSamples * 2, true);

  // Samples are already 16-bit PCM integers from the backend
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }

  const blob = new Blob([buffer], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
const MAX_RECORDING_DURATION_SECS = 120; // 2 minutes
const MAX_UPLOAD_SIZE_MB = 100;
const CONFIGS_STORAGE_KEY = "lab-configs";

function loadSavedConfigs(): VadConfig[] | null {
  try {
    const saved = localStorage.getItem(CONFIGS_STORAGE_KEY);
    if (saved !== null) {
      return JSON.parse(saved) as VadConfig[];
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function createDefaultConfigs(): VadConfig[] {
  return [
    {
      id: "config-1",
      label: "WebRTC VAD",
      backend: "webrtc-vad",
      params: { mode: "very_aggressive" },
      preprocessing: {},
    },
    {
      id: "config-2",
      label: "Silero VAD",
      backend: "silero-vad",
      params: { threshold: 0.5 },
      preprocessing: {},
    },
    {
      id: "config-3",
      label: "TEN VAD",
      backend: "ten-vad",
      params: { threshold: 0.5 },
      preprocessing: {},
    },
    {
      id: "config-4",
      label: "FireRed VAD",
      backend: "firered-vad",
      params: { threshold: 0.5 },
      preprocessing: {},
    },
  ];
}

interface SpectrumFrame {
  timestamp_ms: number;
  magnitudes: number[];
}

function App() {
  const socketRef = useRef<VadLabSocket | null>(null);
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordingRef = useRef(false);
  const configsLoadedRef = useRef(false);
  const [containerWidth, setContainerWidth] = useState(800);
  const [uploading, setUploading] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [loadedFilePath, setLoadedFilePath] = useState<string | null>(null);
  const [fileChannels, setFileChannels] = useState(1);
  const [selectedChannel, setSelectedChannel] = useState<"mixed" | "left" | "right">("mixed");
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [backends, setBackends] = useState<Record<string, ParamInfo[]>>({});
  const [turnBackends, setTurnBackends] = useState<Record<string, ParamInfo[]>>({});
  const [preprocessingParams, setPreprocessingParams] = useState<ParamInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [recording, setRecording] = useState(false);
  const [configs, setConfigs] = useState<VadConfig[]>(() => {
    const saved = loadSavedConfigs();
    if (saved) {
      configsLoadedRef.current = true;
      return saved;
    }
    return [];
  });
  const [samples, setSamples] = useState<number[]>([]);
  const [spectrumData, setSpectrumData] = useState<SpectrumFrame[]>([]);
  const [vadResults, setVadResults] = useState<
    Record<string, Array<{ timestamp_ms: number; probability: number }>>
  >({});
  // Cumulative inference timing per config for RTF computation
  const [vadTiming, setVadTiming] = useState<
    Record<string, { totalInferenceUs: number; totalAudioMs: number; stageTotals: Record<string, number>; frameDurationMs: number }>
  >({});
  const [totalDurationMs, setTotalDurationMs] = useState(0);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsOpen, setLogsOpen] = useState(true);
  const [hoverTimeMs, setHoverTimeMs] = useState<number | null>(null);
  const [viewport, setViewport] = useState<Viewport>(createDefaultViewport);
  const [spectrumBins, setSpectrumBins] = useState(256);
  const [turnConfigs, setTurnConfigs] = useState<TurnConfig[]>([]);
  const [turnResults, setTurnResults] = useState<Record<string, TurnResultPoint[]>>({});
  const [turnTiming, setTurnTiming] = useState<
    Record<string, { stageTotals: Record<string, number>; count: number }>
  >({});
  const [vadOpen, setVadOpen] = useState(true);
  const [turnOpen, setTurnOpen] = useState(true);

  // Preprocessed data per config
  const [preprocessedSamples, setPreprocessedSamples] = useState<Record<string, number[]>>({});
  const [preprocessedSpectrumData, setPreprocessedSpectrumData] = useState<
    Record<string, SpectrumFrame[]>
  >({});
  // Which configs should display their preprocessed waveform/spectrum
  const [showPreprocessed, setShowPreprocessed] = useState<Record<string, boolean>>({});

  // Playback source: "original" or a config ID for preprocessed audio
  const [playbackSource, setPlaybackSource] = useState<string>("original");

  const connected = connectionState === "connected";

  // Persist configs to localStorage whenever they change
  useEffect(() => {
    if (configsLoadedRef.current) {
      localStorage.setItem(CONFIGS_STORAGE_KEY, JSON.stringify(configs));
    }
  }, [configs]);

  // Resolve playback samples based on selected source
  const playbackSamples =
    playbackSource === "original" ? samples : (preprocessedSamples[playbackSource] ?? []);
  const playbackSampleRate =
    playbackSource === "original"
      ? sampleRate
      : // Preprocessed audio is at the same sample rate; if sample count differs
        // slightly due to internal buffering, derive effective rate from duration
        totalDurationMs > 0 && (preprocessedSamples[playbackSource]?.length ?? 0) > 0
        ? Math.round((preprocessedSamples[playbackSource].length / totalDurationMs) * 1000)
        : sampleRate;

  // Audio playback
  const playback = useAudioPlayback({
    samples: playbackSamples,
    sampleRate: playbackSampleRate,
  });

  const addLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
    });
  }, []);

  // Responsive width measurement
  useEffect(() => {
    const container = waveformContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) {
        setContainerWidth(width);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const fetchInitialData = useCallback((socket: VadLabSocket) => {
    socket.send({ type: "list_devices" });
    socket.send({ type: "list_backends" });
    socket.send({ type: "list_turn_backends" });
  }, []);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "devices":
        setDevices(msg.devices);
        setSelectedDevice((prev) => {
          const stillExists = msg.devices.some((d) => String(d.index) === prev);
          if (stillExists) return prev;
          return msg.devices.length > 0 ? String(msg.devices[0].index) : "";
        });
        break;

      case "backends":
        setBackends(msg.backends);
        setPreprocessingParams(msg.preprocessing_params);
        // Create default configs on first visit (no saved configs in localStorage)
        if (!configsLoadedRef.current) {
          configsLoadedRef.current = true;
          setConfigs(createDefaultConfigs());
        } else {
          // Backfill missing params and fix stale Select values in saved configs
          setConfigs((prev) =>
            prev.map((c) => {
              const backendParams = msg.backends[c.backend];
              if (!backendParams) return c;
              let changed = false;
              const params = { ...c.params };
              for (const p of backendParams) {
                if (!(p.name in params)) {
                  params[p.name] = p.default;
                  changed = true;
                } else if (p.param_type.type === "Select") {
                  // Reset to default if saved value doesn't match any valid option
                  const valid = p.param_type.options.map((o) => o.value);
                  if (!valid.includes(String(params[p.name]))) {
                    params[p.name] = p.default;
                    changed = true;
                  }
                }
              }
              return changed ? { ...c, params } : c;
            })
          );
        }
        break;

      case "recording_started":
        setSampleRate(msg.sample_rate);
        break;

      case "audio": {
        setSamples((prev) => [...prev, ...msg.samples]);
        const newEndMs = msg.timestamp_ms + 20;
        setTotalDurationMs(newEndMs);

        // Update viewport during recording so it's set correctly when recording stops
        if (recordingRef.current) {
          setViewport((prev) => ({
            ...prev,
            viewStartMs: Math.max(0, newEndMs - prev.viewDurationMs),
          }));
        }
        break;
      }

      case "spectrum":
        setSpectrumData((prev) => [
          ...prev,
          { timestamp_ms: msg.timestamp_ms, magnitudes: msg.magnitudes },
        ]);
        break;

      case "vad":
        setVadResults((prev) => ({
          ...prev,
          [msg.config_id]: [
            ...(prev[msg.config_id] ?? []),
            { timestamp_ms: msg.timestamp_ms, probability: msg.probability },
          ],
        }));
        setVadTiming((prev) => {
          const existing = prev[msg.config_id] ?? { totalInferenceUs: 0, totalAudioMs: 0, stageTotals: {}, frameDurationMs: 0 };
          const stageTotals = { ...existing.stageTotals };
          for (const st of msg.stage_times ?? []) {
            stageTotals[st.name] = (stageTotals[st.name] ?? 0) + st.us;
          }
          return {
            ...prev,
            [msg.config_id]: {
              totalInferenceUs: existing.totalInferenceUs + msg.inference_us,
              totalAudioMs: existing.totalAudioMs + msg.frame_duration_ms,
              stageTotals,
              frameDurationMs: msg.frame_duration_ms,
            },
          };
        });
        break;

      case "preprocessed_audio":
        setPreprocessedSamples((prev) => ({
          ...prev,
          [msg.config_id]: [...(prev[msg.config_id] ?? []), ...msg.samples],
        }));
        break;

      case "preprocessed_spectrum":
        setPreprocessedSpectrumData((prev) => ({
          ...prev,
          [msg.config_id]: [
            ...(prev[msg.config_id] ?? []),
            { timestamp_ms: msg.timestamp_ms, magnitudes: msg.magnitudes },
          ],
        }));
        break;

      case "turn_backends":
        setTurnBackends(msg.backends);
        // Create default turn config on first receipt if none exist
        setTurnConfigs((prev) => {
          if (prev.length > 0) return prev;
          const backendNames = Object.keys(msg.backends);
          if (backendNames.length === 0) return prev;
          const backend = backendNames[0];
          const params: Record<string, unknown> = {};
          for (const p of msg.backends[backend]) {
            params[p.name] = p.default;
          }
          return [{ id: "turn-1", label: "turn-1", backend, params }];
        });
        break;

      case "turn":
        setTurnResults((prev) => ({
          ...prev,
          [msg.config_id]: [
            ...(prev[msg.config_id] ?? []),
            {
              timestamp_ms: msg.timestamp_ms,
              state: msg.state,
              confidence: msg.confidence,
              latency_ms: msg.latency_ms,
            },
          ],
        }));
        setTurnTiming((prev) => {
          const existing = prev[msg.config_id] ?? { stageTotals: {}, count: 0 };
          const stageTotals = { ...existing.stageTotals };
          for (const st of msg.stage_times ?? []) {
            stageTotals[st.name] = (stageTotals[st.name] ?? 0) + st.us;
          }
          return { ...prev, [msg.config_id]: { stageTotals, count: existing.count + 1 } };
        });
        break;

      case "done":
        recordingRef.current = false;
        setRecording(false);
        setLoadingFile(false);
        break;

      case "error":
        setLoadingFile(false);
        break;
    }
  }, []);

  useEffect(() => {
    const socket = new VadLabSocket();
    socketRef.current = socket;

    const unsubMsg = socket.onMessage(handleMessage);
    const unsubLog = socket.onLog(addLog);

    const unsubConn = socket.onConnection((state) => {
      setConnectionState(state);
      if (state === "connected") {
        fetchInitialData(socket);
      }
      if (state === "reconnecting") {
        recordingRef.current = false;
        setRecording(false);
      }
    });

    socket.connect().catch(() => {
      // reconnect is handled internally
    });

    return () => {
      unsubMsg();
      unsubConn();
      unsubLog();
      socket.disconnect();
    };
  }, [handleMessage, addLog, fetchInitialData]);

  const startRecording = () => {
    const socket = socketRef.current;
    if (!socket || !connected) return;

    setSamples([]);
    setSpectrumData([]);
    setVadResults({});
    setVadTiming({});
    setPreprocessedSamples({});
    setPreprocessedSpectrumData({});
    setTurnResults({});
    setTurnTiming({});
    setPlaybackSource("original");
    setTotalDurationMs(0);
    setSampleRate(null);
    // Clear any loaded file state so channel selector / re-process button don't reappear
    setLoadedFilePath(null);
    setFileChannels(1);
    setSelectedChannel("mixed");
    // Calculate viewport duration based on container width for consistent scroll speed
    setViewport({
      viewStartMs: 0,
      viewDurationMs: calculateViewDuration(containerWidth),
    });

    socket.send({ type: "set_configs", configs });
    socket.send({ type: "set_turn_configs", configs: turnConfigs });
    socket.send({
      type: "start_recording",
      device_index: parseInt(selectedDevice),
      max_duration_secs: MAX_RECORDING_DURATION_SECS,
    });
    recordingRef.current = true;
    setRecording(true);
  };

  const stopRecording = () => {
    const socket = socketRef.current;
    if (!socket) return;

    socket.send({ type: "stop_recording" });
    recordingRef.current = false;
    setRecording(false);
  };

  const loadFile = (path: string, channel: "mixed" | "left" | "right") => {
    const socket = socketRef.current;
    if (!socket || !connected) return;

    // Reset state
    playback.stop();
    setSamples([]);
    setSpectrumData([]);
    setVadResults({});
    setVadTiming({});
    setPreprocessedSamples({});
    setPreprocessedSpectrumData({});
    setTurnResults({});
    setTurnTiming({});
    setPlaybackSource("original");
    setTotalDurationMs(0);
    setSampleRate(null);
    setViewport({ viewStartMs: 0, viewDurationMs: calculateViewDuration(containerWidth) });

    socket.send({ type: "set_configs", configs });
    socket.send({ type: "set_turn_configs", configs: turnConfigs });
    socket.send({ type: "load_file", path, channel });
    setLoadingFile(true);
  };

  const handleFileUpload = async (file: File) => {
    const socket = socketRef.current;
    if (!socket || !connected) return;

    if (file.size > MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
      addLog({ timestamp: new Date(), direction: "system", summary: `File too large (max ${MAX_UPLOAD_SIZE_MB}MB)` });
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/upload", { method: "POST", body: formData });
      if (!res.ok) {
        addLog({ timestamp: new Date(), direction: "system", summary: `Upload failed: ${res.statusText}` });
        return;
      }

      const { path, channels } = await res.json();
      setLoadedFilePath(path);
      setFileChannels(channels ?? 1);
      setSelectedChannel("mixed");
      loadFile(path, "mixed");
    } catch (e) {
      addLog({ timestamp: new Date(), direction: "system", summary: `Upload error: ${e}` });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleChannelChange = (channel: "mixed" | "left" | "right") => {
    setSelectedChannel(channel);
    if (loadedFilePath) {
      loadFile(loadedFilePath, channel);
    }
  };

  const handleSpectrumBinsChange = useCallback((bins: number) => {
    setSpectrumBins(bins);
    socketRef.current?.send({ type: "set_spectrum_bins", bins });
  }, []);

  const connectionColor: Record<ConnectionState, string> = {
    connected: "text-green-500",
    connecting: "text-yellow-500",
    reconnecting: "text-yellow-500",
    disconnected: "text-red-500",
  };

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-bold">wavekat-lab</h1>
          <span className="text-xs text-muted-foreground">by WaveKat</span>
        </div>
        <span className={`text-xs ${connectionColor[connectionState]}`}>
          {connectionState}
        </span>
      </div>

      <Separator />

      {/* Controls */}
      <div className="space-y-3">
        {/* Source controls: Live recording | File upload */}
        <div className="flex items-center gap-6 flex-wrap">
          {/* Live recording group */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Live</span>
            <Select value={selectedDevice} onValueChange={(v) => { if (v) setSelectedDevice(v); }}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select microphone">
                  {devices.find((d) => String(d.index) === selectedDevice)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {devices.map((d) => (
                  <SelectItem key={d.index} value={String(d.index)}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="xs"
              disabled={!connected}
              onClick={() => socketRef.current?.send({ type: "list_devices" })}
            >
              Refresh
            </Button>
            {recording ? (
              <Button variant="destructive" onClick={stopRecording}>
                Stop
              </Button>
            ) : (
              <Button onClick={startRecording} disabled={!connected || configs.length === 0 || loadingFile}>
                Record
              </Button>
            )}
          </div>

          <div className="w-px h-6 bg-border" />

          {/* File upload group */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">File</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".wav,audio/wav"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file);
              }}
            />
            <Button
              variant="outline"
              disabled={!connected || configs.length === 0 || uploading || recording || loadingFile}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "Uploading..." : "Upload WAV"}
            </Button>
            {loadingFile && (
              <Button variant="outline" disabled>
                Processing...
              </Button>
            )}
            {loadedFilePath && !recording && !loadingFile && (
              <>
                {fileChannels > 1 && (
                  <Select value={selectedChannel} onValueChange={(v) => { if (v) handleChannelChange(v as "mixed" | "left" | "right"); }}>
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mixed">Mixed (L+R)</SelectItem>
                      <SelectItem value="left">Left only</SelectItem>
                      <SelectItem value="right">Right only</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <Button
                  variant="outline"
                  disabled={!connected || configs.length === 0}
                  onClick={() => loadFile(loadedFilePath, selectedChannel)}
                >
                  Re-process
                </Button>
              </>
            )}
          </div>

            {/* Hint when no configs exist */}
          {configs.length === 0 && connected && (
            <span className="text-xs text-muted-foreground">
              Add a VAD config below to enable recording and file upload.
            </span>
          )}
        </div>


        {/* Playback controls (visible when audio exists and not recording) */}
        {!recording && !loadingFile && samples.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Playback</span>
            <Select value={playbackSource} onValueChange={(v) => { if (v) { playback.stop(); setPlaybackSource(v); } }}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="original">Original</SelectItem>
                {configs
                  .filter((c) => (preprocessedSamples[c.id]?.length ?? 0) > 0)
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      Preprocessed: {c.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {playback.canPlay && (
              <>
                {!playback.state.isPlaying ? (
                  <Button variant="outline" onClick={playback.play}>
                    Play
                  </Button>
                ) : (
                  <Button variant="outline" onClick={playback.pause}>
                    Pause
                  </Button>
                )}
                <Button variant="ghost" onClick={playback.stop} disabled={playback.state.positionMs === 0}>
                  Stop
                </Button>
              </>
            )}
            {sampleRate && playbackSamples.length > 0 && (
              <Button
                variant="ghost"
                onClick={() => {
                  const label =
                    playbackSource === "original"
                      ? "recording"
                      : configs.find((c) => c.id === playbackSource)?.label ?? playbackSource;
                  const safeName = label.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
                  const effectiveRate = playbackSampleRate ?? sampleRate;
                  const durationSecs = Math.round(playbackSamples.length / effectiveRate);
                  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                  downloadWav(playbackSamples, effectiveRate, `lab_${safeName}_${durationSecs}s_${timestamp}.wav`);
                }}
              >
                Download WAV
              </Button>
            )}
          </div>
        )}
      </div>

      <Separator />

      {/* Waveform and VAD Timelines */}
      <div ref={waveformContainerRef} className="space-y-4">
        <div className="flex items-center gap-2">
          <h3
            className={`text-sm font-medium cursor-pointer select-none inline-flex items-center gap-1.5 ${
              playbackSource === "original" ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => { playback.stop(); setPlaybackSource("original"); }}
          >
            {playbackSource === "original" && <span className="text-xs">&#9835;</span>}
            Waveform
          </h3>
          {!recording && playbackSource === "original" && playback.canPlay && (
            <div className="flex items-center gap-1">
              {!playback.state.isPlaying ? (
                <Button variant="ghost" size="xs" onClick={playback.play}>&#9654;</Button>
              ) : (
                <Button variant="ghost" size="xs" onClick={playback.pause}>&#9646;&#9646;</Button>
              )}
              <Button variant="ghost" size="xs" onClick={playback.stop} disabled={playback.state.positionMs === 0}>&#9632;</Button>
            </div>
          )}
        </div>
        <Waveform
          samples={samples}
          totalDurationMs={totalDurationMs}
          sampleRate={sampleRate}
          viewport={viewport}
          onViewportChange={setViewport}
          width={containerWidth}
          height={120}
          className={`border rounded ${playbackSource === "original" ? "ring-1 ring-foreground/30" : ""}`}
          hoverTimeMs={hoverTimeMs}
          onHoverTimeChange={setHoverTimeMs}
          interactionEnabled={!recording}
          recording={recording}
          playheadMs={!recording && playback.canPlay ? playback.state.positionMs : null}
          onSeek={playback.seek}
          rightControls={
            <ZoomControls
              viewport={viewport}
              totalDurationMs={totalDurationMs}
              onViewportChange={setViewport}
              disabled={recording}
            />
          }
        />

        {/* Spectrogram */}
        <h3 className="text-sm font-medium pt-2">Spectrogram</h3>
        <FrequencySpectrum
          spectrumData={spectrumData}
          sampleRate={sampleRate ?? 48000}
          totalDurationMs={totalDurationMs}
          viewport={viewport}
          onViewportChange={setViewport}
          width={containerWidth}
          height={120}
          className="border rounded"
          hoverTimeMs={hoverTimeMs}
          onHoverTimeChange={setHoverTimeMs}
          recording={recording}
          bins={spectrumBins}
          onBinsChange={handleSpectrumBinsChange}
          playheadMs={!recording && playback.canPlay ? playback.state.positionMs : null}
        />

        {/* VAD Timelines */}
        {configs.length > 0 && (
          <button
            className="flex items-center gap-1 text-sm font-medium pt-2 text-left w-full"
            onClick={() => setVadOpen((v) => !v)}
          >
            <span className="text-muted-foreground text-xs">{vadOpen ? "▼" : "▶"}</span>
            VAD Results
          </button>
        )}
        {vadOpen && configs.map((config, i) => {
          const timing = vadTiming[config.id];
          const rtf = timing && timing.totalAudioMs > 0
            ? (timing.totalInferenceUs / 1000) / timing.totalAudioMs
            : null;
          const numResults = (vadResults[config.id] ?? []).length;
          const stageAvgs = timing && numResults > 0
            ? Object.entries(timing.stageTotals).map(([name, totalUs]) => ({
                name,
                us: totalUs / numResults,
              }))
            : undefined;
          return (
          <VadTimeline
            key={config.id}
            label={config.label}
            config={config}
            results={vadResults[config.id] ?? []}
            rtf={rtf}
            stageAvgs={stageAvgs}
            frameDurationMs={timing?.frameDurationMs}
            totalDurationMs={totalDurationMs}
            viewport={viewport}
            width={containerWidth}
            height={32}
            color={COLORS[i % COLORS.length]}
            hoverTimeMs={hoverTimeMs}
            onHoverTimeChange={setHoverTimeMs}
            recording={recording}
            playheadMs={!recording && playback.canPlay ? playback.state.positionMs : null}
          />
          );
        })}

        {/* Turn Detection Timelines */}
        {turnConfigs.length > 0 && (
          <button
            className="flex items-center gap-1 text-sm font-medium pt-2 text-left w-full"
            onClick={() => setTurnOpen((v) => !v)}
          >
            <span className="text-muted-foreground text-xs">{turnOpen ? "▼" : "▶"}</span>
            Turn Detection
            <div className="flex gap-2 items-center ml-auto" onClick={(e) => e.stopPropagation()}>
              {(["finished", "unfinished", "wait"] as const).map((state) => (
                <span key={state} className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-sm" style={{ background: TURN_STATE_COLORS[state] }} />
                  <span className="text-xs text-muted-foreground font-mono">{state}</span>
                </span>
              ))}
            </div>
          </button>
        )}
        {turnOpen && turnConfigs.map((config) => {
          const timing = turnTiming[config.id];
          const stageAvgs = timing && timing.count > 0
            ? Object.entries(timing.stageTotals).map(([name, totalUs]) => ({
                name,
                us: totalUs / timing.count,
              }))
            : undefined;
          return (
            <TurnTimeline
              key={config.id}
              configId={config.id}
              label={config.label}
              config={config}
              results={turnResults[config.id] ?? []}
              stageAvgs={stageAvgs}
              totalDurationMs={totalDurationMs}
              viewport={viewport}
              width={containerWidth}
              height={32}
              className="border rounded"
              hoverTimeMs={hoverTimeMs}
              onHoverTimeChange={setHoverTimeMs}
              recording={recording}
              playheadMs={!recording && playback.canPlay ? playback.state.positionMs : null}
            />
          );
        })}

        {/* Preprocessed Waveforms/Spectrograms/VAD - only for configs with showPreprocessed enabled */}
        {vadOpen && configs.filter((c) => showPreprocessed[c.id]).map((config) => {
          const configIndex = configs.findIndex((c) => c.id === config.id);
          const color = COLORS[configIndex % COLORS.length];
          const configSamples = preprocessedSamples[config.id] ?? [];
          const configSpectrum = preprocessedSpectrumData[config.id] ?? [];

          return (
            <div key={`preprocessed-${config.id}`} className="space-y-2 pt-4 border-t">
              <div className="flex items-center gap-2 pt-2">
                <div
                  className={`flex items-center gap-2 cursor-pointer select-none ${
                    playbackSource === config.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => { playback.stop(); setPlaybackSource(config.id); }}
                >
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <h3 className="text-sm font-medium">
                    {playbackSource === config.id && <span className="text-xs mr-1">&#9835;</span>}
                    Preprocessed: {config.label}
                  </h3>
                </div>
                {!recording && playbackSource === config.id && playback.canPlay && (
                  <div className="flex items-center gap-1">
                    {!playback.state.isPlaying ? (
                      <Button variant="ghost" size="xs" onClick={playback.play}>&#9654;</Button>
                    ) : (
                      <Button variant="ghost" size="xs" onClick={playback.pause}>&#9646;&#9646;</Button>
                    )}
                    <Button variant="ghost" size="xs" onClick={playback.stop} disabled={playback.state.positionMs === 0}>&#9632;</Button>
                  </div>
                )}
              </div>
              <Waveform
                samples={configSamples}
                totalDurationMs={totalDurationMs}
                // Don't pass sampleRate for preprocessed audio - let it calculate
                // samplesPerMs from actual samples.length / totalDurationMs.
                // Preprocessing (especially denoise) uses internal buffering that
                // can cause the output sample count to differ from the input.
                viewport={viewport}
                onViewportChange={setViewport}
                width={containerWidth}
                height={80}
                className={`border rounded ${playbackSource === config.id ? "ring-1 ring-foreground/30" : ""}`}
                hoverTimeMs={hoverTimeMs}
                onHoverTimeChange={setHoverTimeMs}
                interactionEnabled={!recording}
                recording={recording}
                playheadMs={!recording && playback.canPlay ? playback.state.positionMs : null}
                onSeek={playback.seek}
              />
              <FrequencySpectrum
                spectrumData={configSpectrum}
                sampleRate={sampleRate ?? 48000}
                totalDurationMs={totalDurationMs}
                viewport={viewport}
                onViewportChange={setViewport}
                width={containerWidth}
                height={80}
                className="border rounded"
                hoverTimeMs={hoverTimeMs}
                onHoverTimeChange={setHoverTimeMs}
                recording={recording}
                bins={spectrumBins}
                onBinsChange={handleSpectrumBinsChange}
                playheadMs={!recording && playback.canPlay ? playback.state.positionMs : null}
              />
              <VadTimeline
                label={config.label}
                config={config}
                results={vadResults[config.id] ?? []}
                totalDurationMs={totalDurationMs}
                viewport={viewport}
                width={containerWidth}
                height={32}
                color={color}
                hoverTimeMs={hoverTimeMs}
                onHoverTimeChange={setHoverTimeMs}
                recording={recording}
                playheadMs={!recording && playback.canPlay ? playback.state.positionMs : null}
              />
            </div>
          );
        })}
      </div>

      <Separator />

      {/* VAD Config Panel */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <button
            className="flex items-center gap-1 text-sm font-medium text-left"
            onClick={() => setVadOpen((v) => !v)}
          >
            <span className="text-muted-foreground text-xs">{vadOpen ? "▼" : "▶"}</span>
            VAD Configurations
          </button>
        </div>
        {vadOpen && (
          <ConfigPanel
            configs={configs}
            backends={backends}
            preprocessingParams={preprocessingParams}
            onConfigsChange={setConfigs}
            onResetDefaults={() => setConfigs(createDefaultConfigs())}
            showPreprocessed={showPreprocessed}
            onShowPreprocessedChange={(configId, show) =>
              setShowPreprocessed((prev) => ({ ...prev, [configId]: show }))
            }
          />
        )}
      </div>

      {/* Turn Detection Config Panel */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <button
            className="flex items-center gap-1 text-sm font-medium text-left"
            onClick={() => setTurnOpen((v) => !v)}
          >
            <span className="text-muted-foreground text-xs">{turnOpen ? "▼" : "▶"}</span>
            Turn Detection
          </button>
        </div>
        {turnOpen && (
          <TurnConfigPanel
            configs={turnConfigs}
            backends={turnBackends}
            onConfigsChange={setTurnConfigs}
            onResetDefaults={() => {
              const backendNames = Object.keys(turnBackends);
              if (backendNames.length === 0) return;
              const backend = backendNames[0];
              const params: Record<string, unknown> = {};
              for (const p of turnBackends[backend]) {
                params[p.name] = p.default;
              }
              setTurnConfigs([{ id: "turn-1", label: "turn-1", backend, params }]);
            }}
          />
        )}
      </div>

      <Separator />

      {/* Logs */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">Logs</h3>
          <div className="flex gap-2">
            <Button variant="ghost" size="xs" onClick={() => setLogs([])}>
              Clear
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setLogsOpen((v) => !v)}>
              {logsOpen ? "Hide" : "Show"}
            </Button>
          </div>
        </div>
        {logsOpen && <LogPanel logs={logs} maxHeight={240} />}
      </div>
    </div>
  );
}

export default App;
