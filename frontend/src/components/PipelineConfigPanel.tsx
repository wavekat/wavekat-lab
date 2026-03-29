import { useMemo } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { VadConfig, TurnConfig, PipelineConfig } from "@/lib/websocket";

interface PipelineConfigPanelProps {
  configs: PipelineConfig[];
  vadConfigs: VadConfig[];
  turnConfigs: TurnConfig[];
  onConfigsChange: (configs: PipelineConfig[]) => void;
}

export function PipelineConfigPanel({
  configs,
  vadConfigs,
  turnConfigs,
  onConfigsChange,
}: PipelineConfigPanelProps) {
  const nextId = useMemo(() => {
    let max = 0;
    for (const c of configs) {
      const match = c.id.match(/^pipeline-(\d+)$/);
      if (match) {
        max = Math.max(max, parseInt(match[1], 10));
      }
    }
    return max + 1;
  }, [configs]);

  const canAdd = vadConfigs.length > 0 && turnConfigs.length > 0;

  const addConfig = () => {
    if (!canAdd) return;
    const id = `pipeline-${nextId}`;
    onConfigsChange([
      ...configs,
      {
        id,
        label: `pipeline-${nextId}`,
        vad_config_id: vadConfigs[0].id,
        turn_config_id: turnConfigs[0].id,
        speech_start_threshold: 0.5,
        speech_end_threshold: 0.3,
        min_silence_ms: 300,
      },
    ]);
  };

  const removeConfig = (id: string) => {
    onConfigsChange(configs.filter((c) => c.id !== id));
  };

  const cloneConfig = (config: PipelineConfig) => {
    const id = `pipeline-${nextId}`;
    onConfigsChange([
      ...configs,
      { ...config, id, label: `${config.label} (copy)` },
    ]);
  };

  const updateConfig = (id: string, updates: Partial<PipelineConfig>) => {
    onConfigsChange(
      configs.map((c) => (c.id === id ? { ...c, ...updates } : c))
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={addConfig} disabled={!canAdd}>
          + Add Pipeline
        </Button>
      </div>

      {!canAdd && configs.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Add at least one VAD config and one Turn config first.
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {configs.map((config) => (
          <Card key={config.id} className="relative">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">
                  <Input
                    className="bg-transparent border-none shadow-none outline-none h-auto p-0 text-sm font-semibold"
                    value={config.label}
                    onChange={(e) => updateConfig(config.id, { label: e.target.value })}
                  />
                </CardTitle>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-muted-foreground"
                    title="Clone config"
                    onClick={() => cloneConfig(config)}
                  >
                    &#x29C9;
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-muted-foreground"
                    title="Remove config"
                    onClick={() => removeConfig(config.id)}
                  >
                    &times;
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* VAD Config selector */}
              <div className="space-y-1">
                <Label className="text-xs">VAD Config</Label>
                <Select
                  value={config.vad_config_id}
                  onValueChange={(v) => { if (v) updateConfig(config.id, { vad_config_id: v }); }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="w-auto min-w-64">
                    {vadConfigs.map((vc) => (
                      <SelectItem key={vc.id} value={vc.id}>
                        {vc.label} <span className="text-muted-foreground">({vc.id})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Turn Config selector */}
              <div className="space-y-1">
                <Label className="text-xs">Turn Config</Label>
                <Select
                  value={config.turn_config_id}
                  onValueChange={(v) => { if (v) updateConfig(config.id, { turn_config_id: v }); }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="w-auto min-w-64">
                    {turnConfigs.map((tc) => (
                      <SelectItem key={tc.id} value={tc.id}>
                        {tc.label} <span className="text-muted-foreground">({tc.id})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Thresholds */}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">
                    Speech start
                    <Tooltip>
                      <TooltipTrigger className="text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                        <Info className="size-3" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-56">
                        VAD probability above this value triggers a speech start event. The turn detector begins receiving audio from this point.
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.speech_start_threshold}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (!isNaN(val)) updateConfig(config.id, { speech_start_threshold: val });
                    }}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">
                    Speech end
                    <Tooltip>
                      <TooltipTrigger className="text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                        <Info className="size-3" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-56">
                        VAD probability below this value starts the silence timer. Once silence holds for "min silence" ms, a turn prediction is made. Should be lower than speech start for hysteresis.
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.speech_end_threshold}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (!isNaN(val)) updateConfig(config.id, { speech_end_threshold: val });
                    }}
                    className="h-8 text-xs"
                  />
                </div>
              </div>

              {/* Min silence */}
              <div className="space-y-1">
                <Label className="text-xs flex items-center gap-1">
                  Min silence (ms)
                  <Tooltip>
                    <TooltipTrigger className="text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                      <Info className="size-3" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-56">
                      After VAD drops below the end threshold, silence must hold for this duration before the speech segment closes and a turn prediction fires. Prevents premature cuts on brief pauses.
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={5000}
                  step={50}
                  value={config.min_silence_ms}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val)) updateConfig(config.id, { min_silence_ms: val });
                  }}
                  className="h-8 text-xs w-24"
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
