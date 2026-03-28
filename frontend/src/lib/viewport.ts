/** Viewport state for waveform/timeline visualization */
export interface Viewport {
  /** Left edge of visible window in milliseconds */
  viewStartMs: number;
  /** Width of visible window in milliseconds (zoom level) */
  viewDurationMs: number;
}

/** Target pixels per second for waveform scrolling */
export const PIXELS_PER_SECOND = 32;

/** Calculate viewport duration based on container width */
export function calculateViewDuration(containerWidth: number): number {
  // viewDurationMs = containerWidth / PIXELS_PER_SECOND * 1000
  return (containerWidth / PIXELS_PER_SECOND) * 1000;
}

/** Default viewport duration (5 seconds, used as fallback) */
export const DEFAULT_VIEW_DURATION_MS = 5000;

/** Minimum zoom level in milliseconds (0.5 seconds) */
export const MIN_VIEW_DURATION_MS = 500;

/** Maximum zoom level in milliseconds (60 seconds) */
export const MAX_VIEW_DURATION_MS = 60000;

/** Zoom factor for each wheel tick */
export const ZOOM_FACTOR = 1.2;

/** Create default viewport */
export function createDefaultViewport(): Viewport {
  return {
    viewStartMs: 0,
    viewDurationMs: DEFAULT_VIEW_DURATION_MS,
  };
}

/** Convert pixel position to time in ms */
export function pixelToTime(
  x: number,
  width: number,
  viewport: Viewport
): number {
  return viewport.viewStartMs + (x / width) * viewport.viewDurationMs;
}

/** Convert time in ms to pixel position */
export function timeToPixel(
  timeMs: number,
  width: number,
  viewport: Viewport
): number {
  return ((timeMs - viewport.viewStartMs) / viewport.viewDurationMs) * width;
}

/** Clamp viewport to valid range */
export function clampViewport(
  viewport: Viewport,
  totalDurationMs: number
): Viewport {
  const viewDurationMs = Math.max(
    MIN_VIEW_DURATION_MS,
    Math.min(MAX_VIEW_DURATION_MS, viewport.viewDurationMs)
  );

  // Clamp start position
  const maxStart = Math.max(0, totalDurationMs - viewDurationMs);
  const viewStartMs = Math.max(0, Math.min(maxStart, viewport.viewStartMs));

  return { viewStartMs, viewDurationMs };
}

/** Zoom viewport centered on a specific time position */
export function zoomViewport(
  viewport: Viewport,
  centerTimeMs: number,
  zoomIn: boolean,
  totalDurationMs: number
): Viewport {
  const factor = zoomIn ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
  const newDuration = viewport.viewDurationMs * factor;

  // Calculate new start to keep centerTimeMs at same relative position
  const relativePos =
    (centerTimeMs - viewport.viewStartMs) / viewport.viewDurationMs;
  const newStart = centerTimeMs - relativePos * newDuration;

  return clampViewport(
    { viewStartMs: newStart, viewDurationMs: newDuration },
    totalDurationMs
  );
}

/** Pan viewport by pixel delta */
export function panViewport(
  viewport: Viewport,
  deltaX: number,
  width: number,
  totalDurationMs: number
): Viewport {
  const deltaMs = (deltaX / width) * viewport.viewDurationMs;
  return clampViewport(
    { ...viewport, viewStartMs: viewport.viewStartMs - deltaMs },
    totalDurationMs
  );
}

/** Create viewport that fits all content */
export function fitAllViewport(totalDurationMs: number): Viewport {
  if (totalDurationMs <= 0) {
    return createDefaultViewport();
  }
  return {
    viewStartMs: 0,
    viewDurationMs: Math.max(MIN_VIEW_DURATION_MS, totalDurationMs),
  };
}
