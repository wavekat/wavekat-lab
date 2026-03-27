import { useRef, useState, useCallback, useEffect } from "react";

export interface PlaybackState {
  isPlaying: boolean;
  /** Current playback position in milliseconds */
  positionMs: number;
}

export interface UseAudioPlaybackOptions {
  /** Audio samples as i16 values (-32768 to 32767) */
  samples: number[];
  /** Sample rate in Hz */
  sampleRate: number | null;
  /** Called on each animation frame with current position */
  onPositionChange?: (positionMs: number) => void;
}

export interface UseAudioPlaybackReturn {
  /** Current playback state */
  state: PlaybackState;
  /** Start or resume playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Stop playback and reset position to 0 */
  stop: () => void;
  /** Seek to a specific position in milliseconds */
  seek: (positionMs: number) => void;
  /** Whether playback is available (has samples and sample rate) */
  canPlay: boolean;
}

/**
 * Hook for playing back audio from cached samples using Web Audio API.
 */
export function useAudioPlayback({
  samples,
  sampleRate,
  onPositionChange,
}: UseAudioPlaybackOptions): UseAudioPlaybackReturn {
  const canPlay = samples.length > 0 && sampleRate !== null && sampleRate > 0;
  const durationMs = canPlay ? (samples.length / sampleRate!) * 1000 : 0;

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const startTimeRef = useRef<number>(0);
  const startOffsetRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);
  const onPositionChangeRef = useRef(onPositionChange);
  const durationMsRef = useRef(durationMs);

  const [state, setState] = useState<PlaybackState>({
    isPlaying: false,
    positionMs: 0,
  });

  // Create or update audio buffer when samples change
  useEffect(() => {
    if (!canPlay) {
      audioBufferRef.current = null;
      return;
    }

    // Lazily create AudioContext
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    const ctx = audioContextRef.current;
    const buffer = ctx.createBuffer(1, samples.length, sampleRate!);
    const channelData = buffer.getChannelData(0);

    // Convert i16 samples to float32 (-1.0 to 1.0)
    for (let i = 0; i < samples.length; i++) {
      channelData[i] = samples[i] / 32768;
    }

    audioBufferRef.current = buffer;
  }, [samples, sampleRate, canPlay]);

  // Keep refs in sync
  useEffect(() => {
    onPositionChangeRef.current = onPositionChange;
  }, [onPositionChange]);

  useEffect(() => {
    durationMsRef.current = durationMs;
  }, [durationMs]);

  // Animation loop for position updates (uses refs to avoid recreating callback)
  const updatePosition = useCallback(() => {
    if (!audioContextRef.current) return;

    const elapsed = audioContextRef.current.currentTime - startTimeRef.current;
    const positionMs = startOffsetRef.current + elapsed * 1000;
    const duration = durationMsRef.current;

    if (positionMs >= duration) {
      // Playback finished - reset to beginning
      startOffsetRef.current = 0;
      setState({ isPlaying: false, positionMs: 0 });
      onPositionChangeRef.current?.(0);
      sourceNodeRef.current = null;
      return;
    }

    setState((prev) => ({ ...prev, positionMs }));
    onPositionChangeRef.current?.(positionMs);
    rafIdRef.current = requestAnimationFrame(updatePosition);
  }, []);

  const play = useCallback(() => {
    if (!canPlay || !audioBufferRef.current) return;

    // Ensure AudioContext is running (may be suspended due to autoplay policy)
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    const ctx = audioContextRef.current;

    if (ctx.state === "suspended") {
      ctx.resume();
    }

    // Stop any existing playback
    if (sourceNodeRef.current) {
      sourceNodeRef.current.stop();
      sourceNodeRef.current.disconnect();
    }

    // Create new source node
    const source = ctx.createBufferSource();
    source.buffer = audioBufferRef.current;
    source.connect(ctx.destination);
    sourceNodeRef.current = source;

    // Calculate offset in seconds
    const offsetSeconds = state.positionMs / 1000;
    startTimeRef.current = ctx.currentTime;
    startOffsetRef.current = state.positionMs;

    source.start(0, offsetSeconds);
    setState((prev) => ({ ...prev, isPlaying: true }));

    // Start position update loop
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(updatePosition);

    // Handle natural end of playback
    source.onended = () => {
      if (sourceNodeRef.current === source) {
        // Reset to beginning when playback ends naturally
        startOffsetRef.current = 0;
        setState({ isPlaying: false, positionMs: 0 });
        onPositionChange?.(0);
        sourceNodeRef.current = null;
        if (rafIdRef.current) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
      }
    };
  }, [canPlay, state.positionMs, updatePosition, onPositionChange]);

  const pause = useCallback(() => {
    if (sourceNodeRef.current) {
      sourceNodeRef.current.stop();
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    // Save current position
    if (audioContextRef.current) {
      const elapsed = audioContextRef.current.currentTime - startTimeRef.current;
      const positionMs = Math.min(startOffsetRef.current + elapsed * 1000, durationMs);
      setState({ isPlaying: false, positionMs });
    } else {
      setState((prev) => ({ ...prev, isPlaying: false }));
    }
  }, [durationMs]);

  const stop = useCallback(() => {
    if (sourceNodeRef.current) {
      sourceNodeRef.current.stop();
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    startOffsetRef.current = 0;
    setState({ isPlaying: false, positionMs: 0 });
    onPositionChange?.(0);
  }, [onPositionChange]);

  const seek = useCallback(
    (positionMs: number) => {
      const clampedPosition = Math.max(0, Math.min(positionMs, durationMs));
      startOffsetRef.current = clampedPosition;

      if (state.isPlaying && sourceNodeRef.current && audioBufferRef.current) {
        // Restart playback from new position
        sourceNodeRef.current.stop();
        sourceNodeRef.current.disconnect();

        const ctx = audioContextRef.current!;
        const source = ctx.createBufferSource();
        source.buffer = audioBufferRef.current;
        source.connect(ctx.destination);
        sourceNodeRef.current = source;

        startTimeRef.current = ctx.currentTime;
        source.start(0, clampedPosition / 1000);

        source.onended = () => {
          if (sourceNodeRef.current === source) {
            // Reset to beginning when playback ends naturally
            startOffsetRef.current = 0;
            setState({ isPlaying: false, positionMs: 0 });
            onPositionChange?.(0);
            sourceNodeRef.current = null;
            if (rafIdRef.current) {
              cancelAnimationFrame(rafIdRef.current);
              rafIdRef.current = null;
            }
          }
        };
      }

      setState((prev) => ({ ...prev, positionMs: clampedPosition }));
      onPositionChange?.(clampedPosition);
    },
    [durationMs, state.isPlaying, onPositionChange]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (sourceNodeRef.current) {
        sourceNodeRef.current.stop();
        sourceNodeRef.current.disconnect();
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  // Reset position when samples change (new recording)
  useEffect(() => {
    stop();
  }, [samples.length, stop]);

  return {
    state,
    play,
    pause,
    stop,
    seek,
    canPlay,
  };
}
