import { Button } from "@/components/ui/button";
import {
  type Viewport,
  zoomViewport,
  fitAllViewport,
  MIN_VIEW_DURATION_MS,
  MAX_VIEW_DURATION_MS,
} from "@/lib/viewport";

interface ZoomControlsProps {
  viewport: Viewport;
  totalDurationMs: number;
  onViewportChange: (viewport: Viewport) => void;
  disabled?: boolean;
}

export function ZoomControls({
  viewport,
  totalDurationMs,
  onViewportChange,
  disabled = false,
}: ZoomControlsProps) {
  const handleZoomIn = () => {
    const centerMs = viewport.viewStartMs + viewport.viewDurationMs / 2;
    onViewportChange(zoomViewport(viewport, centerMs, true, totalDurationMs));
  };

  const handleZoomOut = () => {
    const centerMs = viewport.viewStartMs + viewport.viewDurationMs / 2;
    onViewportChange(zoomViewport(viewport, centerMs, false, totalDurationMs));
  };

  const handleFitAll = () => {
    onViewportChange(fitAllViewport(totalDurationMs));
  };

  const canZoomIn = viewport.viewDurationMs > MIN_VIEW_DURATION_MS;
  const canZoomOut = viewport.viewDurationMs < MAX_VIEW_DURATION_MS;

  // Format duration for display
  const formatDuration = (ms: number): string => {
    if (ms >= 1000) {
      return (ms / 1000).toFixed(1) + "s";
    }
    return ms.toFixed(0) + "ms";
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {formatDuration(viewport.viewDurationMs)}
      </span>
      <Button
        variant="outline"
        size="xs"
        onClick={handleZoomIn}
        disabled={disabled || !canZoomIn}
        title="Zoom in (mouse wheel)"
      >
        +
      </Button>
      <Button
        variant="outline"
        size="xs"
        onClick={handleZoomOut}
        disabled={disabled || !canZoomOut}
        title="Zoom out (mouse wheel)"
      >
        −
      </Button>
      <Button
        variant="outline"
        size="xs"
        onClick={handleFitAll}
        disabled={disabled || totalDurationMs <= 0}
        title="Fit all"
      >
        Fit
      </Button>
    </div>
  );
}
