import { useRef, useState, useEffect, useCallback } from "react";
import type { Clip } from "@/lib/api";
import { audioUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { PauseIcon, PlayIcon } from "lucide-react";

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
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [audioError, setAudioError] = useState(false);

  // Reset error state and auto-play when clip changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    setAudioError(false);
    audio.load();
    audio.playbackRate = speed;
    audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  }, [clip.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync playback state
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onEnded = () => setPlaying(false);
    const onError = () => {
      setAudioError(true);
      setPlaying(false);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audioError) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().then(() => setPlaying(true)).catch(() => {});
    }
  }, [playing, audioError]);

  const handleSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || !duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * duration;
    },
    [duration]
  );

  const cycleSpeed = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const idx = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    audio.playbackRate = next;
    setSpeed(next);
  }, [speed]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
        return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        const audio = audioRef.current;
        if (audio) audio.currentTime = Math.max(0, audio.currentTime - 5);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        const audio = audioRef.current;
        if (audio) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="border-t bg-card px-4 py-3">
      <audio ref={audioRef} src={audioUrl(clip.audio_url)} preload="auto" />

      <div className="flex items-center gap-3">
        {/* Play/Pause */}
        <Button variant="outline" size="icon" onClick={togglePlay} disabled={audioError}>
          {playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
        </Button>

        {/* Info + Progress */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-sm">{clip.sentence}</p>

          {audioError ? (
            <p className="text-xs text-muted-foreground">Audio not yet synced</p>
          ) : (
            /* Progress bar */
            <div
              className="group relative h-1.5 cursor-pointer rounded-full bg-muted"
              onClick={handleSeek}
            >
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
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
          </>
        )}
      </div>
    </div>
  );
}
