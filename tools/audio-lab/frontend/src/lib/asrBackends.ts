import type { ParamInfo } from "@/lib/websocket";

/** Backend new configs start with: sherpa-onnx when available (the server
 *  lists backends in arbitrary order). */
export function defaultAsrBackend(
  backends: Record<string, ParamInfo[]>,
): string | undefined {
  const names = Object.keys(backends).sort();
  return names.includes("sherpa-onnx") ? "sherpa-onnx" : names[0];
}
