import { useState, useEffect } from "react";
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
import type { VadConfig, ParamInfo, PreprocessorConfig } from "@/lib/websocket";

interface ConfigPanelProps {
  configs: VadConfig[];
  backends: Record<string, ParamInfo[]>;
  preprocessingParams: ParamInfo[];
  onConfigsChange: (configs: VadConfig[]) => void;
  onResetDefaults: () => void;
  showPreprocessed: Record<string, boolean>;
  onShowPreprocessedChange: (configId: string, show: boolean) => void;
}

export function ConfigPanel({
  configs,
  backends,
  preprocessingParams,
  onConfigsChange,
  onResetDefaults,
  showPreprocessed,
  onShowPreprocessedChange,
}: ConfigPanelProps) {
  const [nextId, setNextId] = useState(1);

  // Sync nextId when configs are loaded externally (localStorage / defaults)
  useEffect(() => {
    let max = 0;
    for (const c of configs) {
      const match = c.id.match(/^config-(\d+)$/);
      if (match) {
        max = Math.max(max, parseInt(match[1], 10));
      }
    }
    setNextId((prev) => Math.max(prev, max + 1));
  }, [configs]);

  const addConfig = () => {
    const backendNames = Object.keys(backends);
    if (backendNames.length === 0) return;

    const backend = backendNames[0];
    const params: Record<string, unknown> = {};
    for (const p of backends[backend]) {
      params[p.name] = p.default;
    }

    const id = `config-${nextId}`;
    setNextId((n) => n + 1);

    onConfigsChange([
      ...configs,
      {
        id,
        label: `config-${nextId}`,
        backend,
        params,
        preprocessing: {},
      },
    ]);
  };

  const removeConfig = (id: string) => {
    onConfigsChange(configs.filter((c) => c.id !== id));
  };

  const cloneConfig = (config: VadConfig) => {
    const id = `config-${nextId}`;
    setNextId((n) => n + 1);

    onConfigsChange([
      ...configs,
      {
        ...config,
        id,
        label: `${config.label} (copy)`,
        params: { ...config.params },
        preprocessing: { ...config.preprocessing },
      },
    ]);
  };

  const updateConfig = (id: string, updates: Partial<VadConfig>) => {
    onConfigsChange(
      configs.map((c) => {
        if (c.id !== id) return c;
        const updated = { ...c, ...updates };

        // If backend changed, reset params to defaults
        if (updates.backend && updates.backend !== c.backend) {
          const newParams: Record<string, unknown> = {};
          for (const p of backends[updates.backend] ?? []) {
            newParams[p.name] = p.default;
          }
          updated.params = newParams;
        }

        return updated;
      })
    );
  };

  const updateParam = (configId: string, paramName: string, value: unknown) => {
    onConfigsChange(
      configs.map((c) => {
        if (c.id !== configId) return c;
        return { ...c, params: { ...c.params, [paramName]: value } };
      })
    );
  };

  const updatePreprocessing = (configId: string, updates: Partial<PreprocessorConfig>) => {
    onConfigsChange(
      configs.map((c) => {
        if (c.id !== configId) return c;
        return {
          ...c,
          preprocessing: { ...c.preprocessing, ...updates },
        };
      })
    );
  };

  // Get high-pass param info for range limits
  const highPassParam = preprocessingParams.find((p) => p.name === "high_pass_hz");
  const highPassRange = highPassParam?.param_type.type === "Float"
    ? highPassParam.param_type.options
    : { min: 20, max: 500 };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">VAD Configurations</h3>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={addConfig}>
            + Add Config
          </Button>
          <Button size="sm" variant="outline" onClick={onResetDefaults}>
            Reset Configs
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {configs.map((config) => {
          const highPassEnabled = config.preprocessing?.high_pass_hz != null;
          const highPassValue = config.preprocessing?.high_pass_hz ?? 80;

          return (
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
                      ⧉
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-muted-foreground"
                      title="Remove config"
                      onClick={() => removeConfig(config.id)}
                    >
                      ×
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Backend Selection */}
                <div className="space-y-1">
                  <Label className="text-xs">Backend</Label>
                  <Select
                    value={config.backend}
                    onValueChange={(v) => { if (v) updateConfig(config.id, { backend: v }); }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.keys(backends).map((b) => (
                        <SelectItem key={b} value={b}>
                          {b}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Backend-specific params */}
                {(backends[config.backend] ?? []).map((param) => (
                  <div key={param.name} className="space-y-1">
                    <Label className="text-xs">{param.description}</Label>
                    {param.param_type.type === "Select" && (
                      <Select
                        value={String(config.params[param.name] ?? param.default)}
                        onValueChange={(v) => { if (v) updateParam(config.id, param.name, v); }}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {param.param_type.options.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {param.param_type.type === "Float" && (
                      <Input
                        type="number"
                        min={param.param_type.options.min}
                        max={param.param_type.options.max}
                        step={0.05}
                        value={Number(config.params[param.name] ?? param.default)}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) {
                            updateParam(config.id, param.name, val);
                          }
                        }}
                        className="h-8 text-xs w-24"
                      />
                    )}
                  </div>
                ))}

                {/* Preprocessing Section */}
                <div className="border-t pt-3 mt-3">
                  <Label className="text-xs text-muted-foreground mb-2 block">Preprocessing</Label>

                  {/* High-pass filter */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id={`highpass-${config.id}`}
                        checked={highPassEnabled}
                        onChange={(e) => {
                          updatePreprocessing(config.id, {
                            high_pass_hz: e.target.checked ? 80 : null,
                          });
                        }}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <Label htmlFor={`highpass-${config.id}`} className="text-xs cursor-pointer">
                        High-pass filter
                      </Label>
                    </div>
                    {highPassEnabled && (
                      <div className="flex items-center gap-2 ml-6">
                        <Input
                          type="number"
                          min={highPassRange.min}
                          max={highPassRange.max}
                          step={10}
                          value={highPassValue}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (!isNaN(val)) {
                              updatePreprocessing(config.id, { high_pass_hz: val });
                            }
                          }}
                          className="h-7 text-xs w-20"
                        />
                        <span className="text-xs text-muted-foreground">Hz</span>
                      </div>
                    )}
                  </div>

                  {/* Noise suppression */}
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="checkbox"
                      id={`denoise-${config.id}`}
                      checked={config.preprocessing?.denoise ?? false}
                      onChange={(e) => {
                        updatePreprocessing(config.id, {
                          denoise: e.target.checked,
                        });
                      }}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <Label htmlFor={`denoise-${config.id}`} className="text-xs cursor-pointer">
                      Noise suppression (RNNoise)
                    </Label>
                  </div>

                  {/* Normalization */}
                  <div className="space-y-2 mt-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id={`normalize-${config.id}`}
                        checked={config.preprocessing?.normalize_dbfs != null}
                        onChange={(e) => {
                          updatePreprocessing(config.id, {
                            normalize_dbfs: e.target.checked ? -20 : null,
                          });
                        }}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <Label htmlFor={`normalize-${config.id}`} className="text-xs cursor-pointer">
                        Normalize level
                      </Label>
                    </div>
                    {config.preprocessing?.normalize_dbfs != null && (
                      <div className="flex items-center gap-2 ml-6">
                        <Input
                          type="number"
                          min={-40}
                          max={0}
                          step={1}
                          value={config.preprocessing.normalize_dbfs}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (!isNaN(val)) {
                              updatePreprocessing(config.id, { normalize_dbfs: val });
                            }
                          }}
                          className="h-7 text-xs w-20"
                        />
                        <span className="text-xs text-muted-foreground">dBFS</span>
                      </div>
                    )}
                  </div>

                  {/* Show preprocessed visualization */}
                  <div className="flex items-center gap-2 mt-3 pt-3 border-t">
                    <input
                      type="checkbox"
                      id={`show-preprocessed-${config.id}`}
                      checked={showPreprocessed[config.id] ?? false}
                      onChange={(e) => {
                        onShowPreprocessedChange(config.id, e.target.checked);
                      }}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <Label htmlFor={`show-preprocessed-${config.id}`} className="text-xs cursor-pointer">
                      Show preprocessed waveform/spectrum
                    </Label>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
