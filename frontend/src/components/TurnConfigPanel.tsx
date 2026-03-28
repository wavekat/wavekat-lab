import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface TurnConfig {
  enabled: boolean;
  intervalMs: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  enabled: true,
  intervalMs: 500,
};

interface TurnConfigPanelProps {
  config: TurnConfig;
  onChange: (config: TurnConfig) => void;
}

export function TurnConfigPanel({ config, onChange }: TurnConfigPanelProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Turn Detection</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-sm">Pipecat Smart Turn</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">wavekat-turn · audio EOU</p>
              </div>
              <span className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">v3</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="turn-enabled"
                checked={config.enabled}
                onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="turn-enabled" className="text-xs cursor-pointer">
                Enabled
              </Label>
            </div>

            {config.enabled && (
              <div className="space-y-1">
                <Label className="text-xs">Prediction interval</Label>
                <Select
                  value={String(config.intervalMs)}
                  onValueChange={(v) => { if (v) onChange({ ...config, intervalMs: Number(v) }); }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="200">200 ms</SelectItem>
                    <SelectItem value="500">500 ms</SelectItem>
                    <SelectItem value="1000">1000 ms</SelectItem>
                    <SelectItem value="2000">2000 ms</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
