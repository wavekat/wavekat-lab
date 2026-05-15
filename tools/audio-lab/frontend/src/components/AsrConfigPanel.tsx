import { useMemo, useState } from "react";
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
import type { AsrConfig, ParamInfo } from "@/lib/websocket";

export type { AsrConfig };

interface AsrConfigPanelProps {
  configs: AsrConfig[];
  backends: Record<string, ParamInfo[]>;
  /** preset name → `true` when its files are already in the HF cache. */
  cacheStatus: Record<string, boolean>;
  /** preset name → in-flight preload state. Absent when idle. */
  preloadStatus: Record<string, "downloading" | "error">;
  /** preset name → last error message, if the most recent preload failed. */
  preloadErrors: Record<string, string>;
  /** Trigger a server-side preload of the named preset. */
  onPreload: (preset: string) => void;
  onConfigsChange: (configs: AsrConfig[]) => void;
  onResetDefaults: () => void;
}

export function AsrConfigPanel({
  configs,
  backends,
  cacheStatus,
  preloadStatus,
  preloadErrors,
  onPreload,
  onConfigsChange,
  onResetDefaults,
}: AsrConfigPanelProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const toggleCollapsed = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const nextId = useMemo(() => {
    let max = 0;
    for (const c of configs) {
      const match = c.id.match(/^asr-(\d+)$/);
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

    const id = `asr-${nextId}`;
    onConfigsChange([
      ...configs,
      { id, label: `asr-${nextId}`, backend, params },
    ]);
  };

  const removeConfig = (id: string) => {
    onConfigsChange(configs.filter((c) => c.id !== id));
  };

  const cloneConfig = (config: AsrConfig) => {
    const id = `asr-${nextId}`;
    onConfigsChange([
      ...configs,
      { ...config, id, label: `${config.label} (copy)`, params: { ...config.params } },
    ]);
  };

  const updateConfig = (id: string, updates: Partial<AsrConfig>) => {
    onConfigsChange(
      configs.map((c) => {
        if (c.id !== id) return c;
        const updated = { ...c, ...updates };

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

      <div className="flex flex-col gap-3">
        {configs.map((config) => {
          const isCollapsed = collapsedIds.has(config.id);
          return (
          <Card key={config.id} className="relative">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm flex-1 min-w-0 flex items-center gap-1">
                  <button
                    type="button"
                    className="text-muted-foreground text-xs shrink-0 px-1"
                    title={isCollapsed ? "Expand" : "Collapse"}
                    onClick={() => toggleCollapsed(config.id)}
                  >
                    {isCollapsed ? "▶" : "▼"}
                  </button>
                  <Input
                    className="bg-transparent border-none shadow-none outline-none h-auto p-0 text-sm font-semibold w-full"
                    value={config.label}
                    onChange={(e) => updateConfig(config.id, { label: e.target.value })}
                  />
                </CardTitle>
                <div className="flex gap-1 shrink-0">
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
            {!isCollapsed && (
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Backend</Label>
                <Select
                  value={config.backend}
                  onValueChange={(v) => { if (v) updateConfig(config.id, { backend: v }); }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="w-auto min-w-64">
                    {Object.keys(backends).map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

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
                      <SelectContent className="w-auto min-w-64">
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

              {config.backend === "sherpa-onnx" && (() => {
                const preset = String(config.params.preset ?? "bilingual");
                const cached = cacheStatus[preset] ?? false;
                const inFlight = preloadStatus[preset];
                const errMsg = preloadErrors[preset];

                let badge: { text: string; tone: "ok" | "warn" | "info" | "err" };
                if (inFlight === "downloading") {
                  badge = { text: "Downloading…", tone: "info" };
                } else if (inFlight === "error") {
                  badge = { text: "Download failed", tone: "err" };
                } else if (cached) {
                  badge = { text: "Model cached", tone: "ok" };
                } else {
                  badge = { text: "Not downloaded", tone: "warn" };
                }
                const toneClass = {
                  ok: "bg-green-100 text-green-800",
                  warn: "bg-amber-100 text-amber-800",
                  info: "bg-blue-100 text-blue-800",
                  err: "bg-red-100 text-red-800",
                }[badge.tone];

                const showPreloadButton =
                  inFlight !== "downloading" && (!cached || inFlight === "error");

                return (
                  <div className="border-t pt-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded ${toneClass}`}>
                        {badge.text}
                      </span>
                      {showPreloadButton && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => onPreload(preset)}
                        >
                          {inFlight === "error" ? "Retry preload" : "Preload model"}
                        </Button>
                      )}
                    </div>
                    {errMsg && inFlight === "error" && (
                      <p className="text-xs text-red-700 break-words">{errMsg}</p>
                    )}
                    {!cached && inFlight !== "downloading" && (
                      <p className="text-xs text-muted-foreground">
                        First record/upload will download the model (~100&nbsp;MB) and may take a minute.
                      </p>
                    )}
                  </div>
                );
              })()}
            </CardContent>
            )}
          </Card>
          );
        })}
      </div>
    </div>
  );
}
