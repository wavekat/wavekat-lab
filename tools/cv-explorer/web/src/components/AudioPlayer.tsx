import { useRef, useState, useEffect, useCallback } from "react";
import type { Clip } from "@/lib/api";
import { authFetch, audioUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DownloadIcon, PauseIcon, PlayIcon } from "lucide-react";
import WaveSurfer from "wavesurfer.js";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface AudioPlayerProps {
  clip: Clip;
}

export function AudioPlayer({ clip }: AudioPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [audioError, setAudioError] = useState(false);

  // Create / recreate wavesurfer when clip changes
  useEffect(() => {
    if (!containerRef.current) return;

    // Destroy previous instance
    wsRef.current?.destroy();
    wsRef.current = null;
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    setAudioError(false);
    setCurrentTime(0);
    setDuration(0);

    let cancelled = false;

    // Fetch audio as blob with auth headers
    authFetch(audioUrl(clip.audio_url))
      .then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.blob();
      })
      .then((blob) => {
        if (cancelled || !containerRef.current) return;

        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;

        const ws = WaveSurfer.create({
          container: containerRef.current,
          url,
          height: 48,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          waveColor: "oklch(0.556 0 0)",
          progressColor: "oklch(0.205 0 0)",
          cursorColor: "oklch(0.205 0 0)",
          cursorWidth: 1,
          normalize: true,
        });

        wsRef.current = ws;

        ws.on("ready", () => {
          setDuration(ws.getDuration());
          ws.setPlaybackRate(speed);
          ws.play().catch(() => setPlaying(false));
        });

        ws.on("timeupdate", (t) => setCurrentTime(t));
        ws.on("finish", () => setPlaying(false));
        ws.on("play", () => setPlaying(true));
        ws.on("pause", () => setPlaying(false));
        ws.on("error", () => {
          setAudioError(true);
          setPlaying(false);
        });
      })
      .catch(() => {
        if (!cancelled) {
          setAudioError(true);
          setPlaying(false);
        }
      });

    return () => {
      cancelled = true;
      wsRef.current?.destroy();
      wsRef.current = null;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [clip.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || audioError) return;
    ws.playPause();
  }, [audioError]);

  const cycleSpeed = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const idx = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    ws.setPlaybackRate(next);
    setSpeed(next);
  }, [speed]);

  const download = useCallback(() => {
    const url = blobUrlRef.current;
    if (!url) return;
    const filename = clip.audio_url.split("/").pop() || "audio.mp3";
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  }, [clip.audio_url]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
        return;

      const ws = wsRef.current;
      if (!ws) return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        ws.setTime(Math.max(0, ws.getCurrentTime() - 5));
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        ws.setTime(Math.min(ws.getDuration(), ws.getCurrentTime() + 5));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay]);

  return (
    <div className="border-t bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        {/* Play/Pause */}
        <Button variant="outline" size="icon" onClick={togglePlay} disabled={audioError}>
          {playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </Button>

        {/* Waveform + sentence */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-sm">{clip.sentence}</p>

          {audioError ? (
            <p className="text-xs text-muted-foreground">Audio not yet synced</p>
          ) : (
            <div ref={containerRef} className="w-full" />
          )}
        </div>

        {!audioError && (
          <>
            {/* Time */}
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatTime(currentTime)}/{formatTime(duration)}
            </span>

            {/* Speed */}
            <Button variant="ghost" size="xs" onClick={cycleSpeed} className="tabular-nums">
              {speed}x
            </Button>

            {/* Download */}
            <Button variant="ghost" size="icon" onClick={download} title="Download audio">
              <DownloadIcon className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
