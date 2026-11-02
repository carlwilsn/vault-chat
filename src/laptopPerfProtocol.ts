/** Content-free v1 measurements. Methods deliberately distinguish presentation from estimates. */
export const PERF_METRICS = ["composer-key", "ctrl-k-key", "fullscreen-transition", "chat-panel-open", "launch-interactive"] as const;
export const PERF_METHODS = ["event-timing", "double-raf-estimate", "native-entry-ready-ipc-upper-bound", "navigation-ready-estimate"] as const;
export type PerfSample = {
  at: string; metric: typeof PERF_METRICS[number]; method: typeof PERF_METHODS[number]; durationMs: number;
  startPoint: "event" | "state-change" | "native-entry" | "navigation";
};
export type PerfBatch = {
  schema: 1; version: string; revision: string; session: string;
  surface: "tauri-production" | "tauri-development" | "browser";
  runtime: "webview2" | "webkitgtk" | "wkwebview" | "browser" | "unknown";
  runtimeVersion: string; eventTiming: boolean; clockQuantumMs: number | null;
  startupTemperature: "unknown"; samples: PerfSample[];
};
const keys = (o: object, names: string[]) => Object.keys(o).every(k => names.includes(k)) && names.every(k => Object.prototype.hasOwnProperty.call(o, k));
export function validPerfBatch(b: unknown): b is PerfBatch {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const v = b as PerfBatch;
  return keys(v, ["schema", "version", "revision", "session", "surface", "runtime", "runtimeVersion", "eventTiming", "clockQuantumMs", "startupTemperature", "samples"])
    && v.schema === 1 && typeof v.version === "string" && v.version.length <= 40 && /^(?:\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?|unknown)$/i.test(v.version)
    && typeof v.revision === "string" && /^(?:[a-f0-9]{40}|unknown)$/.test(v.revision)
    && typeof v.session === "string" && /^[a-z0-9]{1,40}$/.test(v.session)
    && ["tauri-production", "tauri-development", "browser"].includes(v.surface)
    && ["webview2", "webkitgtk", "wkwebview", "browser", "unknown"].includes(v.runtime)
    && typeof v.runtimeVersion === "string" && /^(?:[0-9.]{1,40}|unknown)$/.test(v.runtimeVersion)
    && typeof v.eventTiming === "boolean" && (v.clockQuantumMs === null || (Number.isFinite(v.clockQuantumMs) && v.clockQuantumMs >= 0 && v.clockQuantumMs <= 1000))
    && v.startupTemperature === "unknown" && Array.isArray(v.samples) && v.samples.length > 0 && v.samples.length <= 32
    && v.samples.every(s => s && typeof s === "object" && keys(s, ["at", "metric", "method", "durationMs", "startPoint"])
      && typeof s.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s.at) && Number.isFinite(Date.parse(s.at))
      && ["event", "state-change", "native-entry", "navigation"].includes(s.startPoint)
      && PERF_METRICS.includes(s.metric) && PERF_METHODS.includes(s.method)
      && Number.isFinite(s.durationMs) && s.durationMs >= 0 && s.durationMs <= 600_000
      && (s.method === "event-timing" ? s.startPoint === "event" : s.method === "native-entry-ready-ipc-upper-bound" ? s.startPoint === "native-entry" : s.method === "navigation-ready-estimate" ? s.startPoint === "navigation" : ["event", "state-change"].includes(s.startPoint))
      && (s.metric === "launch-interactive" ? ["native-entry-ready-ipc-upper-bound", "navigation-ready-estimate"].includes(s.method) : ["event-timing", "double-raf-estimate"].includes(s.method)));
}
