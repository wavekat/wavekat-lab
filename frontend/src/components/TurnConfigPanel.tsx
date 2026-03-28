import { useMemo } from "react";
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
import type { TurnConfig, ParamInfo } from "@/lib/websocket";

export type { TurnConfig };

interface TurnConfigPanelProps {
  configs: TurnConfig[];
  backends: Record<string, ParamInfo[]>;
  onConfigsChange: (configs: TurnConfig[]) => void;
  onResetDefaults: () => void;
}

export function TurnConfigPanel({
  configs,
  backends,
  onConfigsChange,
  onResetDefaults,
}: TurnConfigPanelProps) {
  const nextId = useMemo(() => {
    let max = 0;
    for (const c of configs) {
      const match = c.id.match(/^turn-(\d+)$/);
      if (match) {
        max = Math.max(max, parseInt(match[1], 10));
      }
    }
    return max + 1;
  }, [configs]);

  const addConfig = () => {
    const backendNames = Object.keys(backends);
    if (backendNames.length === 0) return;

    const backend = backendNames[0];
    const params: Record<string, unknown> = {};
    for (const p of backends[backend]) {
      params[p.name] = p.default;
    }

    const id = `turn-${nextId}`;
    onConfigsChange([
      ...configs,
      { id, label: `turn-${nextId}`, backend, params },
    ]);
  };

  const removeConfig = (id: string) => {
    onConfigsChange(configs.filter((c) => c.id !== id));
  };

  const cloneConfig = (config: TurnConfig) => {
    const id = `turn-${nextId}`;
    onConfigsChange([
      ...configs,
      { ...config, id, label: `${config.label} (copy)`, params: { ...config.params } },
    ]);
  };

  const updateConfig = (id: string, updates: Partial<TurnConfig>) => {
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={addConfig}>
          + Add Config
        </Button>
        <Button size="sm" variant="outline" onClick={onResetDefaults}>
          Reset Configs
        </Button>
      </div>

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
              {/* Backend selection */}
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
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
