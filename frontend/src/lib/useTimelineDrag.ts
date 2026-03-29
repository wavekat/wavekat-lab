import { useState, useRef, useCallback } from "react";
import { type Viewport, pixelToTime, panViewport } from "./viewport";

interface UseTimelineDragOptions {
  viewport: Viewport;
  effectiveViewport: Viewport;
  width: number;
  totalDurationMs: number;
  recording: boolean;
  onViewportChange?: (v: Viewport) => void;
  onHoverTimeChange?: (timeMs: number | null) => void;
}

export function useTimelineDrag({
  viewport,
  effectiveViewport,
  width,
  totalDurationMs,
  recording,
  onViewportChange,
  onHoverTimeChange,
}: UseTimelineDragOptions) {
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; viewStartMs: number } | null>(null);

  const canDrag = !recording && !!onViewportChange;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!canDrag) return;
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, viewStartMs: viewport.viewStartMs };
    },
    [canDrag, viewport.viewStartMs],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isDragging && dragStartRef.current && canDrag) {
        const deltaX = e.clientX - dragStartRef.current.x;
        const newViewport = panViewport(
          { ...viewport, viewStartMs: dragStartRef.current.viewStartMs },
          deltaX,
          width,
          totalDurationMs,
        );
        onViewportChange!(newViewport);
        return;
      }

      if (!onHoverTimeChange) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const timeMs = pixelToTime(x, width, effectiveViewport);
      onHoverTimeChange(Math.max(0, Math.min(totalDurationMs, timeMs)));
    },
    [isDragging, canDrag, viewport, effectiveViewport, width, totalDurationMs, onViewportChange, onHoverTimeChange],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current = null;
  }, []);

  const handleMouseLeave = useCallback(() => {
    onHoverTimeChange?.(null);
    if (isDragging) {
      setIsDragging(false);
      dragStartRef.current = null;
    }
  }, [onHoverTimeChange, isDragging]);

  return {
    isDragging,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    cursor: canDrag ? (isDragging ? "grabbing" : "grab") : "crosshair",
  } as const;
}
